// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The field-wise three-way merge that moves a variation from one base to
 * another, and the two-way merge that brings one into a WIP. Pure. See
 * `specs/prompt-versions-and-variations.md` §F.
 */

import type {
  ConflictChoices,
  FieldValues,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PendingConflicts,
  VariationConflict,
} from "../../shared/types.ts";
import {
  canonicalizeUpdates,
  emptyUpdates,
  promptFieldValue,
  sameValue,
  updateFields,
  withField,
  withoutUnchanged,
} from "./canonical-updates.ts";

/** The pseudo-field a conflict names when the prompt itself is gone. */
export const PROMPT_FIELD = "prompt";

/**
 * What a merge produced: the updates that went through, and — when it isn't
 * `ok` — the fields that didn't.
 */
export type MergeOutcome =
  | { ok: true; updates: NormalizedPromptUpdates }
  | {
      ok: false;
      /** Every field that did merge. */
      updates: NormalizedPromptUpdates;
      conflicts: VariationConflict[];
    };

/**
 * Re-expresses a variation's `updates` against `target`. Each field the
 * updates set compares three values — the base's being the one the variation
 * recorded overwriting (`baseValues`), so no copy of the base is needed:
 *
 * | `T[f]` vs `B[f]` | `T[f]` vs `V[f]` | result |
 * | --- | --- | --- |
 * | equal | — | take `V[f]` (only the variation changed it) |
 * | differs | equal | drop `f` (both made the same change) |
 * | differs | differs | conflict |
 *
 * A `target` of `undefined` — the prompt doesn't exist there — conflicts on
 * the pseudo-field {@link PROMPT_FIELD}, as does one whose style changed.
 */
export function rebaseUpdates(
  {
    promptId,
    baseValues,
    updates,
  }: {
    promptId: string;
    baseValues: FieldValues;
    updates: NormalizedPromptUpdates;
  },
  target: NormalizedPrompt | undefined,
): MergeOutcome {
  if (!target || target.style !== updates.style) {
    return {
      ok: false,
      updates: emptyUpdates(updates.style),
      conflicts: [
        {
          field: PROMPT_FIELD,
          base: promptId,
          target: target ? `${target.id} (${target.style})` : null,
          variation: promptId,
        },
      ],
    };
  }

  let kept = emptyUpdates(updates.style);
  const conflicts: VariationConflict[] = [];
  for (const [field, value] of updateFields(updates)) {
    const b = baseValues[field];
    const t = promptFieldValue(target, field);
    if (sameValue(t, b)) {
      kept = withField(kept, field, value);
    } else if (!sameValue(t, value)) {
      conflicts.push({ field, base: b, target: t, variation: value });
    }
  }

  const merged = canonicalizeUpdates(target, kept);
  return conflicts.length > 0
    ? { ok: false, updates: merged, conflicts }
    : { ok: true, updates: merged };
}

/**
 * Brings `incoming` into `existing`, both already against `target`: fields
 * only one side sets go through, and a field both set differently conflicts,
 * with the existing side as the conflict's `target`.
 */
export function mergeIntoWip(
  target: NormalizedPrompt,
  existing: NormalizedPromptUpdates,
  incoming: NormalizedPromptUpdates,
): MergeOutcome {
  const existingFields = new Map(updateFields(existing));
  let merged = existing;
  const conflicts: VariationConflict[] = [];
  for (const [field, value] of updateFields(incoming)) {
    if (!existingFields.has(field)) {
      merged = withField(merged, field, value);
      continue;
    }
    const mine = existingFields.get(field);
    if (sameValue(mine, value)) continue;
    conflicts.push({
      field,
      base: promptFieldValue(target, field),
      target: mine,
      variation: value,
    });
  }
  const updates = canonicalizeUpdates(target, merged);
  return conflicts.length > 0
    ? { ok: false, updates, conflicts }
    : { ok: true, updates };
}

/**
 * Settles `pending` with a choice per conflicted field, producing the updates
 * the WIP holds from then on, against `pending.targetValues`. Keeping the
 * working tree's value on a rebase conflict leaves nothing to apply, which
 * the canonicalization drops.
 *
 * @throws When a conflicted field has no choice, or the conflict is on the
 *   prompt itself, which no choice resolves.
 */
export function resolveConflicts(
  pending: PendingConflicts,
  choices: ConflictChoices,
): NormalizedPromptUpdates {
  let updates = pending.updates;
  for (const conflict of pending.conflicts) {
    if (conflict.field === PROMPT_FIELD) {
      throw new Error(
        "The prompt no longer exists at the target; discard these edits instead",
      );
    }
    const choice = choices[conflict.field];
    if (choice !== "target" && choice !== "variation") {
      throw new Error(
        `No choice given for conflicted field '${conflict.field}'`,
      );
    }
    updates = withField(
      updates,
      conflict.field,
      choice === "target" ? conflict.target : conflict.variation,
    );
  }
  return withoutUnchanged(pending.targetValues, updates);
}
