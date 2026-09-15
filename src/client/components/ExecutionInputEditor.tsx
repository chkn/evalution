// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useMemo, useRef } from "react";
import type { EditorPlugin, ItemEditorProps, SlotPath } from "ts-proppy/react";
import { ItemEditor } from "ts-proppy/react";
import type {
  PromptInputSources,
  PropDefinition,
  PropType,
  PropValue,
  ResourceInfo,
} from "../../shared/types";
import { SELF, type SlotSelection } from "./execution-input-state";
import { nestedField, type ResourceArgsContext } from "./resource-args-context";
import { SourceRow } from "./SourceRow";

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
  /**
   * Argument-editor state and how to change it, threaded down so a chosen
   * resource with declared `parameters` can render its own argument form
   * beneath the chip — see `SourceRow` and `specs/resource-arguments.md` §I.
   * Absent (e.g. in a host that doesn't wire it up) simply means no resource
   * here ever shows an argument form, whether or not it has parameters.
   */
  argsContext?: ResourceArgsContext;
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
  argsContext,
}: Props) {
  const byUri = useMemo(
    () => new Map(resources.map(r => [r.uri, r])),
    [resources],
  );

  // `plugins` below has to stay referentially stable while the user is
  // typing — ts-proppy renders a plugin's `component` by reference, so a new
  // one every keystroke unmounts and remounts the field it's editing,
  // dropping focus after every character. `selection` changes on every
  // keystroke (it carries the typed value), so neither `chooseResource` nor
  // the plugin below may depend on it directly; a ref keeps both reading the
  // latest `selection` anyway, just not as a dependency. `argsContext` is the
  // same story and then some — its `resourceArgs` changes on every keystroke
  // of *any* argument form anywhere in the panel, not just this slot's.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const argsContextRef = useRef(argsContext);
  argsContextRef.current = argsContext;

  const chooseResource = useCallback((path: string, uri: string | null) => {
    const current = selectionRef.current;
    const next = { ...(current.resources ?? {}) };
    if (uri) next[path] = uri;
    else delete next[path];
    onChangeRef.current({ ...current, resources: next });
  }, []);

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
    const matches = (type: PropType, path: SlotPath) =>
      type.kind === "opaque" || nestedPaths.has(fullPath(propDef.name, path));
    return [
      {
        match: matches,
        component: (props: ItemEditorProps) => {
          const path = relativePath(props.path);
          const current = argsContextRef.current;
          // `path` is this field's own position relative to the top-level
          // slot (e.g. "list_tasks.db") — folded into the row's identity so
          // it can't collide with an unrelated row that happens to share a
          // name (see `ResourceArgsContext.path`). Empty only if the plugin
          // ever matched the slot's own root item rather than a nested
          // field, which isn't a case ts-proppy produces today; guarded
          // rather than assumed.
          const nestedContext =
            current && path ? nestedField(current, path) : current;
          // A matched node that is itself an object (not opaque — an opaque
          // leaf never reaches this recursive call at all, since `SourceRow`
          // only renders `children` for an editable, i.e. non-opaque, type)
          // must not re-match *itself* on the way back through `ItemEditor`,
          // or it would recurse into this same component forever at the same
          // path. Its own descendants still need every plugin, this one
          // included, so only this exact path is carved out — a sibling
          // match one level deeper (e.g. a nested `db` field) is untouched.
          const selfPath = props.path;
          const childPlugins = plugins.map(p => ({
            ...p,
            match: (type: PropType, at: SlotPath) =>
              at !== selfPath && p.match(type, at),
          }));
          return (
            <SourceRow
              propDef={props.propDef}
              resources={resources}
              matching={matchingFor(slots, propDef.name, props.path, byUri)}
              chosen={selectionRef.current.resources?.[path]}
              onChoose={uri => chooseResource(path, uri)}
              argsContext={nestedContext}
            >
              <ItemEditor
                propDef={props.propDef}
                value={props.value}
                onChange={props.onChange}
                plugins={childPlugins}
                path={props.path}
              />
            </SourceRow>
          );
        },
      },
    ];
  }, [slots, propDef.name, byUri, chooseResource, resources]);

  const ownMatches = matchingFor(slots, propDef.name, [propDef.name], byUri);

  return (
    <SourceRow
      propDef={propDef}
      resources={resources}
      matching={ownMatches}
      chosen={selection.resources?.[SELF]}
      onChoose={uri => chooseResource(SELF, uri)}
      argsContext={argsContext}
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
