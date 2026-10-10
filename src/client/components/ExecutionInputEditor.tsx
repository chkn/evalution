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
import { isPseudoUri } from "./pseudo-sources";
import { SourceRow } from "./SourceRow";
import type { SourceContext } from "./source-context";

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
  /** How chips read, and how a catalog pick becomes an instance — see {@link SourceContext}. */
  context?: SourceContext;
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
  context,
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
  // latest `selection` anyway, just not as a dependency. `context` is the
  // same story: hosts build it inline, so it's new on every render.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const contextRef = useRef(context);
  contextRef.current = context;

  const chooseResource = useCallback((path: string, uri: string | null) => {
    const current = selectionRef.current;
    const next = { ...(current.resources ?? {}) };
    // A pick from the catalog adds an instance to the run; the slot holds a
    // reference to it, like any other pick from "Resources in this run".
    const adopt = contextRef.current?.adopt;
    const chosen = uri && !isPseudoUri(uri) && adopt ? adopt(uri) : uri;
    if (chosen) next[path] = chosen;
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
              context={contextRef.current}
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
      context={context}
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
