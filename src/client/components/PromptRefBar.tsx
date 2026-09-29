// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { shortId, versionLabel } from "../../shared/helpers";
import type {
  ConflictChoices,
  NormalizedPrompt,
  PromptRef,
  VariationConflict,
  VariationInfo,
  VersionInfo,
} from "../../shared/types";
import { getPromptVariations, getPromptVersions } from "../api";
import {
  fieldText,
  refBannerNote,
  refChipLabel,
  variationLabel,
} from "./prompt-ref";
import { diffWords } from "./text-diff";
import { useAnchoredPopover } from "./use-anchored-popover";

/** How many versions the ref menu lists. */
const VERSION_LIMIT = 30;

function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}

interface ChipProps {
  /** The head prompt — whose versions and variations the menu lists. */
  head: NormalizedPrompt;
  /** The prompt as shown, at whatever ref. */
  shown: NormalizedPrompt;
  /** Switches the editor to `ref`, or to head for `undefined`. */
  onSelect: (ref: PromptRef | undefined) => void;
}

/**
 * The ref chip beside the prompt name — "Working tree · ● unsaved" — and the
 * menu it opens: the unsaved edits, named variations, and the versions that
 * changed this prompt's file.
 */
export function PromptRefChip({ head, shown, onSelect }: ChipProps) {
  const [open, setOpen] = useState(false);
  const [variations, setVariations] = useState<VariationInfo[] | null>(null);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  // Fetched on every open: the menu is short-lived, and a fresh list can't be
  // stale.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    Promise.all([
      getPromptVariations(head).catch(() => [] as VariationInfo[]),
      getPromptVersions(head, { limit: VERSION_LIMIT }),
    ])
      .then(([v, h]) => {
        if (cancelled) return;
        setVariations(v);
        setVersions(h);
      })
      .catch(err => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [open, head]);

  const pick = (ref: PromptRef | undefined) => {
    setOpen(false);
    onSelect(ref);
  };
  const current = shown.ref;
  const isCurrent = (ref: Partial<PromptRef>) =>
    (ref.variation ?? undefined) === (current?.variation ?? undefined) &&
    (ref.version ?? undefined) === (current?.version ?? undefined);

  const named = (variations ?? []).filter(v => !v.wip);
  const otherWips = (variations ?? []).filter(v => v.wip && !v.onHead);

  const menu =
    open &&
    createPortal(
      <div className="pg-ref-menu" ref={popoverRef} style={style} role="menu">
        <button
          type="button"
          role="menuitem"
          className="pg-ref-item"
          aria-current={
            (!current?.version && !current?.variation) ||
            (shown.variation?.wip && shown.variation.onHead)
          }
          onClick={() => pick(undefined)}
        >
          <span className="pg-ref-item-name">
            Working tree
            {head.dirty && <span className="pg-ref-dot"> ● unsaved</span>}
          </span>
        </button>

        {loadError && <div className="pg-ref-error">{loadError}</div>}
        {!versions && !loadError && (
          <div className="pg-ref-empty">Loading…</div>
        )}

        {named.length > 0 && <div className="pg-ref-heading">Variations</div>}
        {named.map(v => (
          <button
            key={v.id}
            type="button"
            role="menuitem"
            className="pg-ref-item"
            aria-current={isCurrent({ variation: v.id })}
            onClick={() => pick({ promptId: head.id, variation: v.id })}
          >
            <span className="pg-ref-item-name">{variationLabel(v)}</span>
            <span className="pg-ref-item-meta">on {shortId(v.base)}</span>
          </button>
        ))}

        {otherWips.length > 0 && (
          <div className="pg-ref-heading">Unsaved edits to old versions</div>
        )}
        {otherWips.map(v => (
          <button
            key={v.id}
            type="button"
            role="menuitem"
            className="pg-ref-item"
            aria-current={isCurrent({ variation: v.id })}
            onClick={() => pick({ promptId: head.id, variation: v.id })}
          >
            <span className="pg-ref-item-name">● unsaved</span>
            <span className="pg-ref-item-meta">on {shortId(v.base)}</span>
          </button>
        ))}

        {versions && versions.length > 0 && (
          <div className="pg-ref-heading">History</div>
        )}
        {versions?.map(v => (
          <button
            key={v.id}
            type="button"
            role="menuitem"
            className="pg-ref-item"
            aria-current={isCurrent({ version: v.id })}
            onClick={() => pick({ promptId: head.id, version: v.id })}
            title={v.message}
          >
            <span className="pg-ref-item-name">
              <code>{versionLabel(v)}</code>
              {v.kind === "commit" && v.message && (
                <span className="pg-ref-item-message"> {v.message}</span>
              )}
              {v.kind === "snapshot" && !v.fileOnly && (
                // Several snapshots can share a parent; their own ids tell
                // them apart.
                <span className="pg-ref-item-message"> {shortId(v.id)}</span>
              )}
            </span>
            <span className="pg-ref-item-meta">{relativeTime(v.time)}</span>
          </button>
        ))}
        {versions?.length === 0 && (
          <div className="pg-ref-empty">No saved versions yet</div>
        )}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={
          "pg-ref-chip" +
          (shown.variation?.wip || head.dirty ? " pg-ref-chip--dirty" : "") +
          (shown.atHead === false ? " pg-ref-chip--old" : "")
        }
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Versions and variations"
      >
        <span className="pg-ref-chip-label">{refChipLabel(shown)}</span>
        <span className="pg-ref-chip-caret">▾</span>
      </button>
      {menu}
    </>
  );
}

interface ActionsProps {
  shown: NormalizedPrompt;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onSaveAs: (name: string) => void;
}

/**
 * Save / Discard while there are unsaved edits, and "Save as variation…".
 * "Open on working tree" lives in the {@link RefBanner}.
 */
export function PromptRefActions({
  shown,
  busy,
  onSave,
  onDiscard,
  onSaveAs,
}: ActionsProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const v = shown.variation;
  if (v?.pending) return null; // The conflict bar takes over.

  if (naming) {
    return (
      <form
        className="pg-ref-actions"
        onSubmit={e => {
          e.preventDefault();
          if (!name.trim()) return;
          onSaveAs(name.trim());
          setNaming(false);
          setName("");
        }}
      >
        <input
          autoFocus
          className="pg-ref-name-input"
          placeholder="Variation name"
          aria-label="Variation name"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Escape" && setNaming(false)}
        />
        <button type="submit" className="pg-ref-btn" disabled={busy}>
          Save
        </button>
        <button
          type="button"
          className="pg-ref-btn pg-ref-btn--quiet"
          onClick={() => setNaming(false)}
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="pg-ref-actions">
      {v?.wip && v.onHead && (
        <>
          <button
            type="button"
            className="pg-ref-btn pg-ref-btn--primary"
            onClick={onSave}
            disabled={busy}
            title="Write these edits into the prompt's file (⌘S)"
          >
            Save
          </button>
          <button
            type="button"
            className="pg-ref-btn"
            onClick={onDiscard}
            disabled={busy}
            title="Throw away these edits"
          >
            Discard
          </button>
        </>
      )}
      {v?.wip && !v.onHead && (
        <button
          type="button"
          className="pg-ref-btn"
          onClick={onDiscard}
          disabled={busy}
        >
          Discard
        </button>
      )}
      {v?.wip && (
        <button
          type="button"
          className="pg-ref-btn pg-ref-btn--quiet"
          onClick={() => setNaming(true)}
          disabled={busy}
        >
          Save as variation…
        </button>
      )}
    </div>
  );
}

interface BannerProps {
  shown: NormalizedPrompt;
  busy: boolean;
  onOpenOnHead: () => void;
}

/**
 * "Viewing <what> · <why not here>" over a prompt that can't be edited or run
 * as shown — a saved variation, an old version, or both — with the one way
 * forward: "Open on working tree".
 */
export function RefBanner({ shown, busy, onOpenOnHead }: BannerProps) {
  const note = refBannerNote(shown);
  if (!note) return null;
  const version = shown.version;
  const old = shown.atHead === false;
  return (
    <div className="pg-ref-banner" role="status">
      <span>
        Viewing{" "}
        {shown.variation && <strong>{variationLabel(shown.variation)}</strong>}
        {shown.variation && old && " on "}
        {old && (
          <>
            <code>{version ? versionLabel(version) : "an old version"}</code>
            {version?.message && version.kind === "commit" && (
              <> · {version.message}</>
            )}
          </>
        )}
        . {note}
        {old && version?.fileOnly && (
          <span className="pg-ref-banner-note">
            {" "}
            (File contents only: this version reproduces the prompt, not its
            tools.)
          </span>
        )}
      </span>
      <button
        type="button"
        className="pg-ref-btn"
        onClick={onOpenOnHead}
        disabled={busy}
        title="Bring this into the working tree's unsaved edits, to edit and run"
      >
        Open on working tree
      </button>
    </div>
  );
}

/** Unchanged runs longer than this are folded, keeping this much each side. */
const FOLD_OVER = 280;
const FOLD_KEEP = 100;

/**
 * One conflicting field as a word diff from one side to the other — red for
 * words only the target has, green for words only the variation has — in a
 * box that scrolls, with long unchanged stretches folded away.
 */
function FieldDiff({
  conflict,
  labels,
}: {
  conflict: VariationConflict;
  labels: { target: string; variation: string };
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const segments = diffWords(
    fieldText(conflict.target),
    fieldText(conflict.variation),
  );
  return (
    <div className="pg-conflict-diff-wrap">
      <div className="pg-conflict-legend">
        <span className="pg-diff-del">only in {labels.target}</span>
        <span className="pg-diff-add">only in {labels.variation}</span>
      </div>
      <div className="pg-conflict-diff">
        {segments.map((segment, i) => {
          if (segment.type === "del") {
            return (
              <del key={i} className="pg-diff-del">
                {segment.text}
              </del>
            );
          }
          if (segment.type === "add") {
            return (
              <ins key={i} className="pg-diff-add">
                {segment.text}
              </ins>
            );
          }
          const text = segment.text;
          if (text.length <= FOLD_OVER || expanded.has(i)) {
            return <span key={i}>{text}</span>;
          }
          const head = i === 0 ? "" : text.slice(0, FOLD_KEEP);
          const tail = i === segments.length - 1 ? "" : text.slice(-FOLD_KEEP);
          return (
            <span key={i}>
              {head}
              <button
                type="button"
                className="pg-diff-fold"
                onClick={() => setExpanded(prev => new Set(prev).add(i))}
              >
                … {text.length - head.length - tail.length} unchanged characters
                …
              </button>
              {tail}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Every conflicting field, each with its diff and a choice of side, and an
 * Apply once every field has one.
 */
function ConflictChooser({
  conflicts,
  labels,
  busy,
  applyLabel,
  onApply,
}: {
  conflicts: VariationConflict[];
  labels: { target: string; variation: string };
  busy: boolean;
  applyLabel: string;
  onApply: (choices: ConflictChoices) => void;
}) {
  const [choices, setChoices] = useState<ConflictChoices>({});
  const complete = conflicts.every(c => choices[c.field]);
  return (
    <div className="pg-conflict-fields">
      {conflicts.map(c => (
        <div key={c.field} className="pg-conflict-field">
          <div className="pg-conflict-field-head">
            <span className="pg-conflict-field-name">{c.field}</span>
            <div className="pg-conflict-choices" role="radiogroup">
              {(["target", "variation"] as const).map(side => (
                <label
                  key={side}
                  className={
                    "pg-conflict-choice" +
                    (choices[c.field] === side ? " is-chosen" : "")
                  }
                >
                  <input
                    type="radio"
                    name={`conflict-${c.field}`}
                    checked={choices[c.field] === side}
                    onChange={() =>
                      setChoices(prev => ({ ...prev, [c.field]: side }))
                    }
                  />
                  Keep {side === "target" ? labels.target : labels.variation}
                </label>
              ))}
            </div>
          </div>
          <FieldDiff conflict={c} labels={labels} />
        </div>
      ))}
      <div className="pg-conflict-actions">
        <button
          type="button"
          className="pg-ref-btn pg-ref-btn--primary"
          disabled={busy || !complete}
          onClick={() => onApply(choices)}
          title={complete ? undefined : "Choose a side for every field first"}
        >
          {applyLabel}
        </button>
      </div>
    </div>
  );
}

interface ConflictProps {
  shown: NormalizedPrompt;
  busy: boolean;
  onResolve: (choices: ConflictChoices) => void;
  onDiscard: () => void;
}

/**
 * Takes the place of Save / Discard while a WIP has conflicts — the file
 * changed under unsaved edits to the same fields. Render with a `key` that
 * changes with the conflicts, so a new set starts with no choices made.
 */
export function ConflictBar({
  shown,
  busy,
  onResolve,
  onDiscard,
}: ConflictProps) {
  const pending = shown.variation?.pending;
  if (!pending) return null;
  const unresolvable = pending.conflicts.some(c => c.field === "prompt");
  const { labels } = pending;

  return (
    <div className="pg-conflict-bar" role="alert">
      <div className="pg-conflict-title">
        {unresolvable
          ? "This prompt no longer exists on the working tree."
          : `The ${labels.target} changed ${pending.conflicts.length === 1 ? "a field" : "fields"} your ${labels.variation} also change. Choose which to keep:`}
      </div>
      {!unresolvable && (
        <ConflictChooser
          conflicts={pending.conflicts}
          labels={labels}
          busy={busy}
          applyLabel="Apply"
          onApply={onResolve}
        />
      )}
      <div className="pg-conflict-actions">
        <button
          type="button"
          className="pg-ref-btn"
          disabled={busy}
          onClick={onDiscard}
        >
          Discard {labels.variation}
        </button>
      </div>
    </div>
  );
}

/** Conflicts reported by "Open on working tree", awaiting the user's call. */
export interface OpenOnHeadConflict {
  conflicts: VariationConflict[];
  labels: { target: string; variation: string };
}

/**
 * What "Open on working tree" shows when the unsaved edits there change the
 * same fields as what's being opened. Nothing has changed yet; the three ways
 * out are: throw the unsaved edits away and open exactly this, go back to
 * viewing it, or combine the two with a choice per field.
 */
export function OpenOnHeadConflicts({
  conflict,
  what,
  busy,
  onReplace,
  onCancel,
  onCombine,
}: {
  conflict: OpenOnHeadConflict;
  /** What's being opened, e.g. `fa74276`. */
  what: string;
  busy: boolean;
  onReplace: () => void;
  onCancel: () => void;
  onCombine: (choices: ConflictChoices) => void;
}) {
  const { conflicts, labels } = conflict;
  const unresolvable = conflicts.some(c => c.field === "prompt");
  // Discarding the unsaved edits only helps when they're what conflicts.
  const withUnsaved = labels.target === "unsaved edits";
  const fields = conflicts.map(c => c.field).join(", ");

  return (
    <div className="pg-conflict-bar pg-open-conflicts" role="alertdialog">
      <div className="pg-conflict-title">
        {unresolvable
          ? `${what} can't be opened: this prompt no longer exists on the working tree.`
          : withUnsaved
            ? `Your unsaved edits also change ${fields}. How should ${what} be opened?`
            : `The working tree has changed ${fields} since ${what}. How should it be opened?`}
      </div>

      <div className="pg-open-options">
        {withUnsaved && (
          <button
            type="button"
            className="pg-ref-btn"
            disabled={busy}
            onClick={onReplace}
          >
            Discard unsaved edits and open {what}
          </button>
        )}
        <button
          type="button"
          className="pg-ref-btn pg-ref-btn--quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>

      {!unresolvable && (
        <div className="pg-open-combine">
          <div className="pg-open-combine-title">
            Or combine {what} with the {labels.target}, choosing for each field:
          </div>
          <ConflictChooser
            conflicts={conflicts}
            labels={labels}
            busy={busy}
            applyLabel={`Open ${what} with these choices`}
            onApply={onCombine}
          />
        </div>
      )}
    </div>
  );
}
