// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useMemo } from "react";
import type { EditorPlugin, ItemEditorProps, SlotPath } from "ts-proppy/react";
import { ItemEditor } from "ts-proppy/react";
import type {
  PromptInputSources,
  PropDefinition,
  PropValue,
  ResourceInfo,
} from "../../shared/types";
import { SELF, type SlotSelection } from "./execution-input-state";

interface Props {
  /** The slot being edited. */
  propDef: PropDefinition;
  /** Current editor state for this slot. */
  selection: SlotSelection;
  /** Called with the slot's next state. */
  onChange: (selection: SlotSelection) => void;
  /** Every resource in scope, for label lookup. */
  resources: readonly ResourceInfo[];
  /**
   * Slot path → resource URIs that fit it. Paths are rooted at this slot's own
   * name, as computed provider-side.
   */
  slots: Record<string, string[]>;
}

/**
 * One row of the execute panel: a source dropdown, plus whichever control the
 * chosen source calls for.
 *
 * The two decisions here are independent, which is the point:
 *
 * - **Can this slot be typed into?** Decided by its type alone. A `TaskId` slot
 *   keeps its text field even when a resource is offered for it.
 * - **Can something else fill it?** Decided by matching, provider-side. An
 *   `opaque` slot has only this, which is why the dropdown *is* its control.
 *
 * Nested slots get the same treatment through an editor plugin keyed on the
 * slot's path, so a `db` field buried inside `toolsContext` collapses to a
 * picker while its sibling ids keep their string editors.
 */
export function ExecutionInputEditor({
  propDef,
  selection,
  onChange,
  resources,
  slots,
}: Props) {
  const byUri = useMemo(
    () => new Map(resources.map(r => [r.uri, r])),
    [resources],
  );

  const chooseResource = useCallback(
    (path: string, uri: string | null) => {
      const next = { ...(selection.resources ?? {}) };
      if (uri) next[path] = uri;
      else delete next[path];
      onChange({ ...selection, resources: next });
    },
    [selection, onChange],
  );

  // Nested slots are handled by a plugin rather than by a bespoke recursive
  // editor: `ItemEditor` already walks the shape correctly, and threading the
  // slot path through it is all that was missing.
  //
  // Registered unconditionally: an opaque field needs this treatment even
  // when `slots` has no nested matches at all — that's the common case for a
  // `db`-shaped field nobody has wired a resource to yet, and it's exactly
  // when the "here's what to do about it" hint matters most. Bailing out
  // early here previously let such fields fall through to ts-proppy's
  // generic (resource-unaware) opaque placeholder instead.
  const plugins = useMemo<EditorPlugin[]>(() => {
    const nestedPaths = new Set(
      Object.keys(slots).filter(p => p !== propDef.name),
    );
    return [
      {
        match: (type, path) =>
          type.kind === "opaque" ||
          nestedPaths.has(fullPath(propDef.name, path)),
        component: (props: ItemEditorProps) => {
          const path = relativePath(props.path);
          return (
            <SourceRow
              propDef={props.propDef}
              matching={matchingFor(slots, propDef.name, props.path, byUri)}
              chosen={selection.resources?.[path]}
              onChoose={uri => chooseResource(path, uri)}
            >
              <ItemEditor
                propDef={props.propDef}
                value={props.value}
                onChange={props.onChange}
                path={props.path}
              />
            </SourceRow>
          );
        },
      },
    ];
    // `selection` is read inside the plugin, so the plugin has to be rebuilt
    // when it changes; `chooseResource` closes over the same state.
  }, [slots, propDef.name, byUri, selection, chooseResource]);

  const ownMatches = matchingFor(slots, propDef.name, [propDef.name], byUri);

  return (
    <SourceRow
      propDef={propDef}
      matching={ownMatches}
      chosen={selection.resources?.[SELF]}
      onChoose={uri => chooseResource(SELF, uri)}
    >
      <ItemEditor
        propDef={propDef}
        value={selection.value}
        onChange={(value: PropValue) => onChange({ ...selection, value })}
        plugins={plugins}
        path={[propDef.name]}
      />
    </SourceRow>
  );
}

/**
 * A slot's source dropdown and the control beneath it.
 *
 * With a resource chosen the editor is replaced by a chip rather than seeded
 * from it: a resource's value does not exist until the run creates it, so
 * there is nothing to show. (Seeding an editor from a stored value is what a
 * dataset row is for.)
 */
function SourceRow({
  propDef,
  matching,
  chosen,
  onChoose,
  children,
}: {
  propDef: PropDefinition;
  matching: ResourceInfo[];
  chosen: string | undefined;
  onChoose: (uri: string | null) => void;
  children: React.ReactNode;
}) {
  const editable = propDef.type.kind !== "opaque";
  const selected = chosen ? matching.find(r => r.uri === chosen) : undefined;
  // A stored choice whose resource is gone — renamed, deleted, or in a module
  // that now fails to load. It stays listed, and selected, because it is still
  // what a run would send: dropping it silently would show an editor while
  // submitting the resource behind it.
  const stale = chosen && !selected ? chosen : undefined;

  if (matching.length === 0 && !stale && editable) return <>{children}</>;

  return (
    <div className="pg-slot">
      {(matching.length > 0 || stale) && (
        <select
          className="pg-slot-source"
          value={chosen ?? ""}
          onChange={e => onChoose(e.target.value || null)}
          aria-label={`Source for ${propDef.name}`}
        >
          {/* An opaque slot has no editor to fall back to, so it offers no
              "Custom" — picking a source is the only way to fill it. */}
          {editable && <option value="">Custom</option>}
          {!editable && !chosen && <option value="">Choose a resource…</option>}
          {matching.map(r => (
            <option key={r.uri} value={r.uri}>
              {r.label}
            </option>
          ))}
          {stale && <option value={stale}>{stale} (unavailable)</option>}
        </select>
      )}

      {selected ? (
        <span className="pg-slot-chip" title={selected.uri}>
          {selected.label}
          <em className="pg-slot-chip-note">
            {selected.scope === "server"
              ? "created once per server"
              : "created for each run"}
          </em>
        </span>
      ) : stale ? (
        <div className="pg-slot-hint">
          <span>This resource is no longer available</span>
        </div>
      ) : editable ? (
        children
      ) : (
        // The type already appears in this slot's own label, right above —
        // repeating it here would just be noise.
        <div className="pg-slot-hint">
          <span>No value editor for this type</span>
          {/* TODO: point at real docs once they exist. */}
          <a
            className="pg-slot-hint-help"
            href="https://example.com/docs/opaque-types"
            target="_blank"
            rel="noreferrer"
            aria-label="Learn more about opaque types"
          >
            ?
          </a>
        </div>
      )}
    </div>
  );
}

/** The dotted slot path a nested editor sits at, rooted at the parameter. */
function fullPath(rootName: string, path: SlotPath | undefined): string {
  return (path ?? [rootName]).join(".");
}

/** The same path, relative to the top-level slot — `''` for the slot itself. */
function relativePath(path: SlotPath | undefined): string {
  return (path ?? []).slice(1).join(".");
}

function matchingFor(
  slots: Record<string, string[]>,
  rootName: string,
  path: SlotPath | undefined,
  byUri: Map<string, ResourceInfo>,
): ResourceInfo[] {
  const uris = slots[fullPath(rootName, path)] ?? [];
  return uris
    .map(uri => byUri.get(uri))
    .filter((r): r is ResourceInfo => !!r && !r.error);
}

/** Resources whose playground module failed to load, for the panel to report. */
export function brokenResources(
  sources: PromptInputSources | undefined,
): ResourceInfo[] {
  return (sources?.resources ?? []).filter(r => !!r.error);
}
