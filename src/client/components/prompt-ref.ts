// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Pure helpers for showing which state of a prompt the editor is on — head,
 * an old version, a variation — and what can be done there. See
 * `specs/prompt-versions-and-variations.md` §I.
 */

import { shortId, versionLabel } from "../../shared/helpers";
import type {
  NormalizedPrompt,
  PromptRef,
  VariationInfo,
} from "../../shared/types";

/** A variation's name, or a stand-in for an unnamed one. */
export function variationLabel(v: VariationInfo): string {
  if (v.names.length > 0) return v.names[0];
  if (v.wip) return "unsaved edits";
  return `variation ${shortId(v.id)}`;
}

/** Whether `ref` names head — nothing but a prompt id. */
export function isHeadRef(ref: PromptRef | undefined): boolean {
  return !ref || (ref.version === undefined && ref.variation === undefined);
}

/**
 * The ref an editor tab shows: the tab's own ref when it names something
 * other than head, else the head prompt's unsaved edits when there are some,
 * else head (`undefined`). Unsaved edits to head are what head *looks like*
 * in the editor, like an unsaved buffer.
 */
export function effectiveRef(
  head: NormalizedPrompt,
  tabRef: PromptRef | undefined,
): PromptRef | undefined {
  if (!isHeadRef(tabRef)) return tabRef;
  if (head.wipId) return { promptId: head.id, variation: head.wipId };
  return undefined;
}

/**
 * Whether a prompt as read at some ref is the head prompt's own unsaved
 * edits — which the tab tracks through the head prompt's `wipId` rather than
 * holding a ref of its own.
 */
export function isHeadWip(prompt: NormalizedPrompt): boolean {
  return !!prompt.variation?.wip && !!prompt.variation.onHead;
}

/** What the ref chip in the prompt header says. */
export function refChipLabel(prompt: NormalizedPrompt): string {
  const v = prompt.variation;
  const base = prompt.version ? versionLabel(prompt.version) : undefined;
  if (v?.wip) {
    const where = v.onHead ? "Working tree" : (base ?? "Old version");
    return `${where} · ● unsaved`;
  }
  if (v) {
    const name = variationLabel(v);
    return prompt.atHead === false && base ? `${name} · on ${base}` : name;
  }
  if (prompt.ref?.version && base) {
    return prompt.version?.message
      ? `${base} · ${prompt.version.message}`
      : base;
  }
  return prompt.dirty ? "Working tree · ● unsaved" : "Working tree";
}

/** How "Open on working tree" names what it's opening: a variation, or a version. */
export function openingLabel(prompt: NormalizedPrompt): string {
  if (prompt.variation) return variationLabel(prompt.variation);
  if (prompt.version) return versionLabel(prompt.version);
  return "this version";
}

/**
 * Whether `prompt` is a saved (named or run) variation: read-only, since
 * editing one would have to decide where the edit lands. "Open on working
 * tree" is how its changes become editable.
 */
export function isSavedVariation(prompt: NormalizedPrompt): boolean {
  return !!prompt.variation && !prompt.variation.wip;
}

/** `prompt` with every field marked read-only, for showing it as it is. */
export function asReadOnly(prompt: NormalizedPrompt): NormalizedPrompt {
  const common = { modelEditable: false, modelParametersEditable: false };
  return prompt.style === "chat"
    ? {
        ...prompt,
        ...common,
        systemEditable: false,
        messagesEditable: false,
      }
    : {
        ...prompt,
        ...common,
        stateEditable: false,
        questionsEditable: false,
      };
}

/**
 * What the banner over a prompt says it can't do from here — be edited, as
 * a saved variation; be run, as an old version — or `undefined` for no
 * banner.
 */
export function refBannerNote(prompt: NormalizedPrompt): string | undefined {
  const saved = isSavedVariation(prompt);
  const old = prompt.atHead === false;
  if (saved && old) {
    return "Saved variations are read-only, and run only on the working tree.";
  }
  if (saved) return "Saved variations are read-only.";
  if (old) return "Running is only available on the working tree.";
  return undefined;
}

/** Why this prompt can't run from here, or `undefined` when it can. */
export function runDisabledReason(
  prompt: NormalizedPrompt,
): string | undefined {
  if (prompt.variation?.pending) {
    return "Resolve the conflicts before running.";
  }
  if (prompt.atHead === false) {
    return "Running is only available on the working tree.";
  }
  return undefined;
}

/**
 * A field value in full, as text to diff: a message list becomes one
 * `role: content` paragraph per message.
 */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map(m =>
        m && typeof m === "object" && "role" in m
          ? `${(m as { role: string }).role}: ${describe((m as { content?: unknown }).content)}`
          : describe(m),
      )
      .join("\n\n");
  }
  return describe(value);
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "(not set)";
  if (Array.isArray(value)) {
    // A message list.
    return value.length === 0
      ? "(none)"
      : `${value.length} message${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value !== "object") return String(value);
  const v = value as Record<string, any>;
  if (typeof v.displayValue === "string") return v.displayValue;
  switch (v.kind) {
    case "primitive":
      return typeof v.value === "string" ? v.value : String(v.value);
    case "template":
      return (v.value as unknown[])
        .map(s => (typeof s === "string" ? s : `\${${(s as any).expr}}`))
        .join("");
    case "functionCall":
      return `${v.callee}(${(v.args as unknown[]).map(describe).join(", ")})`;
    case "reference":
      return (v.path as string[]).join(".");
    case "raw":
      return v.sourceText;
    default:
      return JSON.stringify(value);
  }
}
