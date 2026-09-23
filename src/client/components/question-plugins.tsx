// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useRef, useState } from "react";
import type { EditorPlugin, ItemEditorProps } from "ts-proppy/react";
import {
  canRemoveTupleElement,
  defaultValueForType,
  ItemEditor,
  listElements,
  ParameterMenu,
  RecordEditor,
  useInterpolatables,
} from "ts-proppy/react";
import type { PropDefinition, PropType, PropValue } from "../../shared/types";

/**
 * The members of an "entry" union — text, or JSON structure, or `null` — the
 * shape TypeSafe and the AI SDK's evaluations use for instructions, criteria
 * and state. `undefined` for any other type.
 */
export function entryMembers(
  type: PropType,
): { text: PropType; structured: PropType[]; nullable: boolean } | undefined {
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
  const nullable = type.types.some(
    t => t.kind === "constant" && t.value === null,
  );
  return { text, structured, nullable };
}

const NULL: PropValue = { kind: "primitive", value: null };

/** Whether `value` is `null` — for an entry, "no description". */
export function isNull(value: PropValue | undefined): boolean {
  return value?.kind === "primitive" && value.value === null;
}

/**
 * Whether `type` is a record of nullable entries — a choice's criteria, whose
 * options may go without a description. A new option starts as `null` there:
 * its label is what was asked for, and an empty description (`""`) is not
 * the same as none.
 */
export function isNullableEntryRecord(type: PropType): boolean {
  return type.kind === "record" && !!entryMembers(type.value.type)?.nullable;
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

/** The levels of a score rubric's type: see {@link scoreLevelSlots}. */
export interface ScoreLevelSlots {
  /** Levels the type fixes, each with its own definition. */
  fixed: PropDefinition[];
  /** The definition of each level past the fixed ones. */
  rest: PropDefinition;
  /** How few levels a rubric may have; that many rows are always shown. */
  min: number;
}

/**
 * The levels of a score rubric, if `type` is one: a list of entries (see
 * {@link entryMembers}) that is either
 *
 * - a variadic tuple of at least two (`[E, E, ...E[]]`, TypeSafe's), or
 * - a plain array at a `criteria` slot (`E[]`, the AI SDK's), which only its
 *   docs say needs two levels — as does any rubric.
 */
export function scoreLevelSlots(
  type: PropType,
  path: readonly string[],
): ScoreLevelSlots | undefined {
  if (type.kind === "tuple") {
    const { elements, rest } = type;
    if (!rest || elements.length < 2) return undefined;
    if (![...elements, rest].every(e => !!entryMembers(e.type)))
      return undefined;
    return { fixed: elements, rest, min: elements.length };
  }
  if (
    type.kind === "array" &&
    path[path.length - 1] === "criteria" &&
    entryMembers(type.element.type)
  ) {
    return { fixed: [], rest: type.element, min: 2 };
  }
  return undefined;
}

/**
 * Plugins for question-and-state request types — TypeSafe's, and the AI
 * SDK's evaluations. Each matches on shape, so without them every slot is
 * still editable through the generic editors; with them the common case reads
 * like a form rather than a type.
 */
export function questionPlugins(): EditorPlugin[] {
  const plugins: EditorPlugin[] = [];

  /**
   * Text by default, with a switch to JSON structure. A nullable entry's
   * `null` shows as "None", and a button sets it.
   */
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
    const text = isNull(value) ? undefined : value;

    // `null` is shown as "None" until the user starts writing, and writing
    // only replaces it once something is typed: leaving an empty editor keeps
    // the `null` rather than writing `""`.
    const none = members.nullable && isNull(value);
    const [writing, setWriting] = useState(false);
    const entryRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!writing) return;
      entryRef.current
        ?.querySelector<HTMLElement>(
          '[contenteditable="true"], input, textarea',
        )
        ?.focus();
    }, [writing]);

    // A `null` default is what a new entry starts as (see
    // `isNullableEntryRecord`), not a placeholder to show.
    const { defaultValue, ...rest } = propDef;
    const def = isNull(defaultValue) ? rest : propDef;

    return (
      <div
        className="pg-entry"
        ref={entryRef}
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setWriting(false);
          }
        }}
      >
        {none && !writing ? (
          <button
            type="button"
            className="pg-entry-none"
            title="None (null). Click to write one."
            disabled={disabled}
            onClick={() => setWriting(true)}
          >
            None
          </button>
        ) : (
          <ItemEditor
            propDef={{ ...def, type }}
            value={structured ? value : text}
            onChange={onChange}
            plugins={plugins}
            path={path}
            disabled={disabled}
            className={structured ? undefined : "token-editor pg-entry-text"}
          />
        )}
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
        {members.nullable && !none && (
          <button
            type="button"
            className="pg-entry-set-null"
            title="Set to null"
            disabled={disabled}
            onClick={() => {
              setMode({ slot, structured: false });
              setWriting(false);
              onChange(NULL);
            }}
          >
            None
          </button>
        )}
      </div>
    );
  }

  /** A record of nullable entries, whose new entries start as `null`. */
  function NullableEntryRecordEditor({
    propDef,
    value,
    onChange,
    path,
    disabled,
  }: ItemEditorProps) {
    if (propDef.type.kind !== "record") return null;
    return (
      <RecordEditor
        value={{ ...propDef.type.value, defaultValue: NULL }}
        current={value}
        onChange={onChange}
        plugins={plugins}
        path={path}
        disabled={disabled}
      />
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
    const slots = scoreLevelSlots(propDef.type, path);
    if (!slots) return null;
    const { fixed, rest, min } = slots;
    const levels = listElements(value);
    const count = Math.max(levels.length, min);
    const levelDef = (i: number): PropDefinition => ({
      ...(fixed[i] ?? rest),
      name: `Level ${i}`,
    });
    // A tuple's fixed levels stay; an array's levels go while above its minimum.
    const removable = (i: number) =>
      fixed.length > 0
        ? canRemoveTupleElement(i, fixed.length)
        : i < levels.length && levels.length > min;
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
            {removable(i) ? (
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
            )}
          </li>
        ))}
        <button
          type="button"
          className="pg-add-level-btn"
          disabled={disabled}
          onClick={() => {
            // Rows shown below the minimum are filled in first.
            const next = [...levels];
            for (let j = next.length; j < count; j++) {
              next[j] = defaultValueForType(levelDef(j).type);
            }
            set([...next, defaultValueForType(rest.type)]);
          }}
        >
          ＋ Add level
        </button>
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
      match: isNullableEntryRecord,
      component: NullableEntryRecordEditor,
    },
    {
      match: (type, path) => !!scoreLevelSlots(type, path),
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
