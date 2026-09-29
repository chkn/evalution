// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
/*
function TracesIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="6" y1="18" x2="16" y2="18" />
    </svg>
  );
}

function NewVariantIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}
*/
import type {
  ConflictChoices,
  ExecuteResponse,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PromptRef,
  PropDefinition,
  RebaseResult,
} from "../../shared/types";
import {
  discardVariation,
  getModelDefinition,
  getPromptAt,
  nameVariation,
  type OpenOnHeadRequest,
  openVariationOnHead,
  openVersionOnHead,
  resolveVariation,
  saveVariation,
  updatePromptProperties,
} from "../api";
import { autosave } from "../autosave";
import { usePersistentValue } from "../hooks/usePersistentValue";
import { createInFlight } from "../in-flight";
import type { PanelFill, PanelFillSource } from "./named-inputs";
import { applyOptimisticUpdates } from "./optimistic-updates";
import PlaygroundEditor from "./PlaygroundEditor";
import PlaygroundExecution from "./PlaygroundExecution";
import {
  ConflictBar,
  type OpenOnHeadConflict,
  OpenOnHeadConflicts,
  PromptRefActions,
  PromptRefChip,
  RefBanner,
} from "./PromptRefBar";
import {
  asReadOnly,
  effectiveRef,
  isHeadRef,
  isHeadWip,
  isSavedVariation,
  openingLabel,
  runDisabledReason,
} from "./prompt-ref";
import { PromptLinkIcon } from "./trace/icons.tsx";

/** How long edits settle before autosave writes them. */
const AUTOSAVE_DELAY_MS = 800;

interface Props {
  /** The prompt as it is at head. */
  prompt: NormalizedPrompt;
  /**
   * The version or variation this tab shows instead of head, if any. Head's
   * own unsaved edits aren't one: they're found through the head prompt's
   * `wipId`, as an editor finds an unsaved buffer.
   */
  promptRef?: PromptRef;
  /** Switches this tab to another ref, or back to head for `undefined`. */
  onRefChange?: (ref: PromptRef | undefined) => void;
  /** Bumped whenever prompts changed elsewhere, so a ref's prompt is re-read. */
  refreshKey?: number;
  /** Asks for every prompt to be re-read — after a save, say. */
  onRefresh?: () => void;
  onUpdate: (updated: NormalizedPrompt) => void;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Invoked after a successful execution with the trace that was registered
   * for it. Lets the surrounding app open a trace tab in a split pane.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
  /** A one-shot request to overwrite the execute panel — see `PanelFill`. */
  fill?: PanelFill;
  /** Opens where a fill came from — the notice's "trace ↗" / "dataset ↗". */
  onOpenFillSource?: (from: PanelFillSource) => void;
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
}

function promptKey(prompt: NormalizedPrompt): string {
  return stableKey(prompt);
}

/** Whether an action's result is a rebase that stopped on conflicts. */
function isFailedRebase(
  result: unknown,
): result is Extract<RebaseResult, { ok: false }> {
  return (
    !!result &&
    typeof result === "object" &&
    (result as RebaseResult).ok === false
  );
}

/**
 * Whether a prompt read at some ref is one that can never change — an old
 * version, or a frozen variation — and so can be kept and shown again at once.
 */
function isImmutableRead(read: NormalizedPrompt): boolean {
  if (read.variation) return !read.variation.wip;
  return !!read.ref?.version;
}

/** Whether `v` is head's unsaved edits, ready to be written into the file. */
function isSavable(
  v: NormalizedPrompt["variation"],
): v is NonNullable<NormalizedPrompt["variation"]> {
  return !!v?.wip && !!v.onHead && !v.pending;
}

function refKey(ref: PromptRef | undefined): string {
  return ref
    ? `${ref.promptId}|${ref.version ?? ""}|${ref.variation ?? ""}`
    : "";
}

function PlaygroundContent({
  prompt,
  promptRef,
  onRefChange,
  refreshKey,
  onRefresh,
  onUpdate,
  onDirtyChange,
  onExecuted,
  fill,
  onOpenFillSource,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelDefinition, setModelDefinition] = useState<PropDefinition | null>(
    null,
  );
  const [autosaveEnabled] = usePersistentValue(autosave);

  // The ref shown, and the prompt read at it. A provider with no versions
  // never has one, and everything below degrades to editing head in place.
  const ref = effectiveRef(prompt, promptRef);
  const [refPrompt, setRefPrompt] = useState<NormalizedPrompt | null>(null);
  // The ref the prompt on screen was read at. Until it's the current one, what
  // shows is the previous prompt, dimmed — never another ref's content
  // passed off as this one's.
  const [loadedFor, setLoadedFor] = useState("");
  // Prompts read at refs that never change, by ref.
  const refCache = useRef(new Map<string, NormalizedPrompt>());
  const shown =
    ref && refPrompt && refPrompt.id === prompt.id ? refPrompt : prompt;
  const versioned = !!prompt.ref;
  const loading = !!ref && loadedFor !== refKey(ref);

  const shownRef = useRef(shown);
  const refRef = useRef(ref);
  const headRef = useRef(prompt);
  useEffect(() => {
    shownRef.current = shown;
    refRef.current = ref;
    headRef.current = prompt;
  });

  useEffect(() => {
    onDirtyChange(saving);
  }, [saving, onDirtyChange]);

  useEffect(() => {
    if (prompt.providerId) {
      // Cleared first, so a style switch never shows the other style's slot.
      setModelDefinition(null);
      getModelDefinition(prompt.providerId, prompt.style)
        .then(setModelDefinition)
        .catch(() => {});
    }
  }, [prompt.providerId, prompt.style]);

  /** Makes `landed` — where the server says the prompt now is — the tab's ref. */
  const adopt = useCallback(
    (landed: NormalizedPrompt) => {
      const head = headRef.current;
      // Already read: nothing to wait for — which matters most for the first
      // edit, whose new WIP must not dim the editor mid-keystroke.
      if (landed.ref) setLoadedFor(refKey(landed.ref));
      if (isHeadRef(landed.ref)) {
        // Back at head: the unsaved edits are gone, or never were.
        setRefPrompt(null);
        if (!isHeadRef(promptRef)) onRefChange?.(undefined);
        onUpdate(landed);
        return;
      }
      setRefPrompt(landed);
      if (isHeadWip(landed)) {
        // Head's own unsaved edits: tracked through head's `wipId`.
        if (!isHeadRef(promptRef)) onRefChange?.(undefined);
        if (head.wipId !== landed.variation!.id || !head.dirty) {
          onUpdate({ ...head, dirty: true, wipId: landed.variation!.id });
        }
      } else if (refKey(landed.ref) !== refKey(promptRef)) {
        onRefChange?.(landed.ref);
      }
    },
    [promptRef, onRefChange, onUpdate],
  );

  // Read the prompt at the tab's ref whenever it — or anything, elsewhere —
  // changes. A ref that no longer resolves (unsaved edits saved from another
  // tab) falls back to head.
  const currentRefKey = refKey(ref);
  // `refPrompt` and `adopt` are read, not reacted to: this re-reads when the
  // ref or the world changes, not when the reading does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!ref || !prompt.providerId) {
      setRefPrompt(null);
      return;
    }
    // A version or named variation never changes: one read before, it
    // shows at once — refreshed below, for head's annotations.
    const cached = refCache.current.get(currentRefKey);
    if (cached) {
      setRefPrompt(cached);
      setLoadedFor(currentRefKey);
    }
    let cancelled = false;
    getPromptAt(prompt.providerId, prompt.id, ref)
      .then(read => {
        if (cancelled) return;
        if (isImmutableRead(read)) refCache.current.set(currentRefKey, read);
        setLoadedFor(currentRefKey);
        if (
          refPrompt &&
          promptKey(read) === promptKey(refPrompt) &&
          refKey(read.ref) === currentRefKey
        ) {
          return;
        }
        adopt(read);
      })
      .catch(() => {
        if (cancelled) return;
        setRefPrompt(null);
        onRefChange?.(undefined);
        onRefresh?.();
      });
    return () => {
      cancelled = true;
    };
  }, [currentRefKey, refreshKey, prompt.providerId, prompt.id]);

  // Edits sent but not yet landed. A save waits them out: sent ahead of them,
  // it would write the unsaved edits without them.
  const [updatesInFlight] = useState(createInFlight);

  const applyUpdate = useCallback(
    async (updates: NormalizedPromptUpdates) => {
      const basePrompt = shownRef.current;
      const atRef = refRef.current;
      const optimisticPrompt = applyOptimisticUpdates(basePrompt, updates);
      if (promptKey(optimisticPrompt) !== promptKey(basePrompt)) {
        shownRef.current = optimisticPrompt;
        // With versions, edits land in a variation — never in head itself —
        // so they're shown on the ref's prompt, and head stays head.
        if (versioned) setRefPrompt(optimisticPrompt);
        else onUpdate(optimisticPrompt);
      }

      setSaving(true);
      setError(null);
      try {
        const { prompt: updated } = await updatePromptProperties(
          basePrompt,
          updates,
          atRef,
        );
        if (!versioned) {
          if (promptKey(updated) !== promptKey(shownRef.current)) {
            shownRef.current = updated;
            onUpdate(updated);
          }
        } else {
          shownRef.current = updated;
          adopt(updated);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setSaving(false);
      }
    },
    [onUpdate, versioned, adopt],
  );

  const handleUpdate = useCallback(
    (updates: NormalizedPromptUpdates) =>
      updatesInFlight.track(applyUpdate(updates)),
    [updatesInFlight, applyUpdate],
  );

  /** Runs a ref-bar action, reporting its failure (or conflicts) in the header. */
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        if (isFailedRebase(result)) {
          setError(
            `Conflicts on ${result.conflicts.map(c => c.field).join(", ")} — resolve them in the conflict bar.`,
          );
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(false);
        onRefresh?.();
      }
    },
    [onRefresh],
  );

  // A saved variation shows as it is: its changes are edited by opening it
  // on the working tree, from the banner.
  const editorPrompt = useMemo(
    () => (isSavedVariation(shown) ? asReadOnly(shown) : shown),
    [shown],
  );

  const providerId = prompt.providerId ?? "";
  const variation = shown.variation;

  const handleSave = useCallback(() => {
    if (updatesInFlight.size === 0 && !isSavable(shownRef.current.variation)) {
      return;
    }
    void act(async () => {
      await updatesInFlight.settled();
      const wip = shownRef.current.variation;
      if (!isSavable(wip)) return;
      const result = await saveVariation(providerId, wip.id);
      if (result.ok) {
        setRefPrompt(null);
        onUpdate({ ...headRef.current, dirty: undefined, wipId: undefined });
      }
      return result;
    });
  }, [act, updatesInFlight, providerId, onUpdate]);

  const handleDiscard = () =>
    variation &&
    act(async () => {
      await discardVariation(providerId, variation.id);
      setRefPrompt(null);
      onRefChange?.(undefined);
      if (variation.onHead) {
        onUpdate({ ...headRef.current, dirty: undefined, wipId: undefined });
      }
    });

  const handleSaveAs = (name: string) =>
    variation &&
    act(async () => {
      await nameVariation(providerId, variation.id, name);
    });

  // Conflicts "Open on working tree" found, while the user decides what to
  // do about them. Nothing has changed yet.
  const [openConflict, setOpenConflict] = useState<
    (OpenOnHeadConflict & { key: number }) | null
  >(null);

  const openOnHead = (options: OpenOnHeadRequest = {}) =>
    act(async () => {
      const result = variation
        ? await openVariationOnHead(providerId, variation.id, options)
        : await openVersionOnHead(prompt, shown.ref!.version!, options);
      if (!result.ok) {
        // Stay where we are, and ask.
        setOpenConflict(prev => ({
          conflicts: result.conflicts,
          labels: result.labels ?? {
            target: "unsaved edits",
            variation: "this version",
          },
          key: (prev?.key ?? 0) + 1,
        }));
        return;
      }
      // Wherever it landed, the working tree's unsaved edits now hold it.
      setOpenConflict(null);
      setRefPrompt(null);
      onRefChange?.(undefined);
    });

  const handleOpenOnHead = () => openOnHead();

  // A decision about one ref doesn't carry over to another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on ref change
  useEffect(() => setOpenConflict(null), [currentRefKey]);

  const handleResolve = (choices: ConflictChoices) =>
    variation && act(() => resolveVariation(providerId, variation.id, choices));

  // ⌘S / Ctrl+S saves the unsaved edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        const wip = shownRef.current.variation;
        if ((wip?.wip && wip.onHead) || updatesInFlight.size > 0) {
          e.preventDefault();
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, updatesInFlight]);

  // Autosave: once edits settle, write them — today's write-through, through
  // the same machinery.
  const autosaveKey =
    autosaveEnabled && variation?.wip && variation.onHead && !variation.pending
      ? `${variation.id}@${variation.updatedAt}`
      : undefined;
  useEffect(() => {
    if (!autosaveKey || saving) return;
    const timer = setTimeout(handleSave, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autosaveKey, saving, handleSave]);

  return (
    <div className="pg-playground-wrapper">
      <div className="pg-prompt-header">
        <div className="pg-prompt-header-row">
          <span className="pg-prompt-name">{prompt.name}</span>
          {versioned && (
            <PromptRefChip
              head={prompt}
              shown={shown}
              onSelect={next => onRefChange?.(next)}
            />
          )}
          <div className="pg-prompt-header-right">
            {error && (
              <div className="pg-header-error">
                {error}
                <button
                  type="button"
                  className="pg-dismiss"
                  onClick={() => setError(null)}
                >
                  ×
                </button>
              </div>
            )}
            {versioned && (
              <PromptRefActions
                shown={shown}
                busy={busy}
                onSave={handleSave}
                onDiscard={handleDiscard}
                onSaveAs={handleSaveAs}
              />
            )}
          </div>
        </div>
        {prompt.treePath && prompt.treePath.length > 0 && (
          <span className="pg-prompt-path">
            <PromptLinkIcon />
            <span className="pg-prompt-path-text">
              {prompt.treePath.join("/")}
            </span>
          </span>
        )}
        {openConflict ? (
          <OpenOnHeadConflicts
            key={openConflict.key}
            conflict={openConflict}
            what={openingLabel(shown)}
            busy={busy}
            onReplace={() => openOnHead({ replace: true })}
            onCancel={() => setOpenConflict(null)}
            onCombine={choices => openOnHead({ choices })}
          />
        ) : (
          <RefBanner
            shown={shown}
            busy={busy}
            onOpenOnHead={handleOpenOnHead}
          />
        )}
        <ConflictBar
          key={JSON.stringify(variation?.pending?.conflicts ?? null)}
          shown={shown}
          busy={busy}
          onResolve={handleResolve}
          onDiscard={handleDiscard}
        />
      </div>
      <div
        className={"pg-content" + (loading ? " pg-content--loading" : "")}
        aria-busy={loading}
      >
        <div className="pg-editor-col">
          <PlaygroundEditor
            prompt={editorPrompt}
            onUpdate={handleUpdate}
            modelDefinition={modelDefinition}
          />
        </div>
        <div className="pg-exec-col">
          <PlaygroundExecution
            prompt={shown}
            promptRef={ref}
            runDisabledReason={runDisabledReason(shown)}
            onExecuted={onExecuted}
            fill={fill}
            onOpenFillSource={onOpenFillSource}
          />
        </div>
      </div>
    </div>
  );
}

export default PlaygroundContent;
