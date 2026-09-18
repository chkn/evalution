// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { EditorPlugin, ItemEditorProps } from "ts-proppy/react";
import {
  canRemoveTupleElement,
  defaultValueForType,
  ItemEditor,
  listElements,
  ParameterMenu,
  useInterpolatables,
} from "ts-proppy/react";
import type { PropDefinition, PropType, PropValue } from "../../shared/types";

/**
 * The members of an "entry" union — text, or JSON structure, or `null` — the
 * shape TypeSafe uses for instructions, criteria and state. `undefined` for
 * any other type.
 */
export function entryMembers(
  type: PropType,
): { text: PropType; structured: PropType[] } | undefined {
  if (type.kind !== "union") return undefined;
  const text = type.types.find(
    t => t.kind === "primitive" && (t.base ?? t.syntax) === "string",
  );
  const structured: PropType[] = type.types.filter(
    t => t.kind === "record" || t.kind === "array",
  );
  const rest = type.types.filter(
    t =>
      t !== text &&
      !structured.includes(t) &&
      !(t.kind === "constant" && t.value === null),
  );
  if (!text || structured.length === 0 || rest.length > 0) return undefined;
  return { text, structured };
}

/** Whether an entry's value is text (or nothing yet) rather than JSON structure. */
export function isTextEntry(value: PropValue | undefined): boolean {
  return (
    value === undefined ||
    value.kind === "template" ||
    value.kind === "reference" ||
    (value.kind === "primitive" &&
      (typeof value.value === "string" || value.value == null))
  );
}

/**
 * Plugins for TypeSafe's request types. Each matches on shape, so without them
 * every slot is still editable through the generic editors; with them the
 * common case reads like a form rather than a type.
 */
export function questionPlugins(): EditorPlugin[] {
  const plugins: EditorPlugin[] = [];

  /** Text by default, with a switch to JSON structure. */
  function EntryEditor({
    propDef,
    value,
    onChange,
    path,
    disabled,
  }: ItemEditorProps) {
    const members = entryMembers(propDef.type)!;
    const interpolatables = useInterpolatables();
    // Question cards are keyed by position so renaming one keeps focus, which
    // means a delete hands this instance a different slot's value. `path`
    // identifies the slot, so the mode is re-derived when it changes.
    const slot = path?.join("/") ?? "";
    const [mode, setMode] = useState({
      slot,
      structured: !isTextEntry(value),
    });
    const structured =
      mode.slot === slot ? mode.structured : !isTextEntry(value);
    const structuredType: PropType =
      members.structured.length === 1
        ? members.structured[0]
        : {
            kind: "union",
            syntax: members.structured.map(t => t.syntax).join(" | "),
            types: members.structured,
          };
    const type: PropType = structured ? structuredType : members.text;
    const text =
      value?.kind === "primitive" && value.value === null ? undefined : value;
    return (
      <div className="pg-entry">
        <ItemEditor
          propDef={{ ...propDef, type }}
          value={structured ? value : text}
          onChange={onChange}
          plugins={plugins}
          path={path}
          disabled={disabled}
          className={structured ? undefined : "token-editor pg-entry-text"}
        />
        {/* The state is where a whole parameter is most often passed in
            (`state: ticket`); elsewhere `${…}` in the text is enough. */}
        {path?.length === 1 && interpolatables?.length ? (
          <ParameterMenu
            interpolatables={interpolatables}
            onChange={onChange}
            disabled={disabled}
          />
        ) : null}
        <button
          type="button"
          className="pg-entry-toggle"
          disabled={disabled}
          onClick={() => {
            setMode({ slot, structured: !structured });
            onChange(
              defaultValueForType(structured ? members.text : structuredType),
            );
          }}
        >
          {structured ? "Text" : "JSON"}
        </button>
      </div>
    );
  }

  /** Score levels as a numbered list, never shorter than the rubric requires. */
  function ScoreLevelsEditor({
    propDef,
    value,
    onChange,
    path = [],
    disabled,
  }: ItemEditorProps) {
    if (propDef.type.kind !== "tuple") return null;
    const { elements: fixed, rest } = propDef.type;
    const levels = listElements(value);
    const count = Math.max(levels.length, fixed.length);
    const levelDef = (i: number): PropDefinition => ({
      ...(fixed[i] ?? rest!),
      name: `Level ${i}`,
    });
    const set = (next: PropValue[]) =>
      onChange({ kind: "array", elements: next });
    return (
      <ol className="pg-score-levels" start={0}>
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="pg-score-level">
            <span className="pg-score-level-number">{i}</span>
            <div className="pg-score-level-editor">
              <ItemEditor
                propDef={levelDef(i)}
                value={levels[i]}
                onChange={v => {
                  const next = [...levels];
                  for (let j = next.length; j < i; j++) {
                    next[j] = defaultValueForType(levelDef(j).type);
                  }
                  next[i] = v;
                  set(next);
                }}
                plugins={plugins}
                path={[...path, String(i)]}
                disabled={disabled}
              />
            </div>
            {rest &&
              (canRemoveTupleElement(i, fixed.length) ? (
                <button
                  type="button"
                  className="pg-delete-msg"
                  title="Remove level"
                  disabled={disabled}
                  onClick={() => set(levels.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              ) : (
                <span
                  className="pg-delete-msg pg-delete-msg-spacer"
                  aria-hidden="true"
                >
                  ×
                </span>
              ))}
          </li>
        ))}
        {rest && (
          <button
            type="button"
            className="pg-add-level-btn"
            disabled={disabled}
            onClick={() => set([...levels, defaultValueForType(rest.type)])}
          >
            ＋ Add level
          </button>
        )}
      </ol>
    );
  }

  /** A yes/no question's two outcome descriptions, labelled as such. */
  function NoulCriteriaEditor({
    propDef,
    value,
    onChange,
    path = [],
    disabled,
  }: ItemEditorProps) {
    if (propDef.type.kind !== "object") return null;
    const props = value?.kind === "object" ? value.properties : {};
    return (
      <div className="pg-noul-criteria">
        {propDef.type.properties.map(p => (
          <div key={p.name} className="pg-noul-outcome">
            <span className="pg-noul-outcome-label">
              <strong>{p.name === "true" ? "Yes" : "No"}</strong> means
            </span>
            <ItemEditor
              propDef={p}
              value={props[p.name]}
              onChange={v =>
                onChange({
                  kind: "object",
                  properties: { ...props, [p.name]: v },
                })
              }
              plugins={plugins}
              path={[...path, p.name]}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
    );
  }

  plugins.push(
    {
      match: type => !!entryMembers(type),
      component: EntryEditor,
    },
    {
      match: type =>
        type.kind === "tuple" &&
        !!type.rest &&
        type.elements.length >= 2 &&
        [...type.elements, type.rest].every(e => !!entryMembers(e.type)),
      component: ScoreLevelsEditor,
    },
    {
      match: (type, path) =>
        type.kind === "object" &&
        path[path.length - 1] === "criteria" &&
        type.properties.length === 2 &&
        type.properties.every(p => p.name === "true" || p.name === "false"),
      component: NoulCriteriaEditor,
    },
  );
  return plugins;
}
