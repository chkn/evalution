// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { shortSyntax } from "ts-proppy/react";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  InputLayout,
  NormalizedPrompt,
  PropDefinition,
} from "../../shared/types";
import { executePrompt } from "../api";
import { CombinedInputEditor } from "./CombinedInputEditor";
import {
  collapseLossy,
  expand,
  type FieldGroup,
  fanOutGroups,
  isCombinable,
  resolveLayout,
} from "./combined-inputs";
import { brokenResources, ExecutionInputEditor } from "./ExecutionInputEditor";
import {
  fromExecutionInput,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";

interface Props {
  prompt: NormalizedPrompt;
  /**
   * Invoked with the trace reference returned by the execute endpoint. Lets
   * the surrounding app open the corresponding trace tab.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
}

/** Editor state for one prompt's inputs, keyed by slot name. */
type Selections = Record<string, SlotSelection>;

/** Per-slot layout choices, split the same way `Selections` is. */
interface LayoutChoices {
  fn: Record<string, InputLayout>;
  exec: Record<string, InputLayout>;
}

/** Per-slot "what got overwritten by forcing combined mode" notes. Not persisted. */
type OverwrittenNotes = {
  fn: Record<string, Record<string, string[]>>;
  exec: Record<string, Record<string, string[]>>;
};

/** What is persisted between sessions: the inputs themselves, not the values. */
interface StoredInputs {
  functionInputs?: Record<string, ExecutionInput>;
  executeInputs?: Record<string, ExecutionInput>;
  /** The user's explicit layout choice, by slot path. Absent until they touch the toggle. */
  layout?: {
    functionSlots?: Record<string, InputLayout>;
    executeSlots?: Record<string, InputLayout>;
  };
}

// `globalId` survives file moves/renames, so it's the more stable key when
// present; `id` (always present) is the fallback.
function paramStorageKey(prompt: NormalizedPrompt): string {
  return `pg-exec-params:${prompt.globalId ?? prompt.id}`;
}

/**
 * Restore the panel from what was saved last time.
 *
 * An {@link ExecutionInput} is what gets stored, rather than a bare value: a
 * resource choice has no value to save, and storing the recipe is what lets a
 * template come back as a template rather than as the string it flattened to.
 */
function loadStored(prompt: NormalizedPrompt): {
  fn: Selections;
  exec: Selections;
  layout: LayoutChoices;
} {
  const empty = { fn: {}, exec: {}, layout: { fn: {}, exec: {} } };
  try {
    const raw = localStorage.getItem(paramStorageKey(prompt));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as StoredInputs;
    if (!parsed || typeof parsed !== "object") return empty;
    const restore = (inputs: Record<string, ExecutionInput> = {}) =>
      Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => [
          name,
          fromExecutionInput(input),
        ]),
      );
    return {
      fn: restore(parsed.functionInputs),
      exec: restore(parsed.executeInputs),
      layout: {
        fn: parsed.layout?.functionSlots ?? {},
        exec: parsed.layout?.executeSlots ?? {},
      },
    };
  } catch {
    /* ignore (private browsing, quota, corrupt entry, etc.) */
    return empty;
  }
}

/** Replace (or clear) one `which`/`name` entry of a `{fn, exec}`-shaped record. */
function withEntry<T>(
  obj: Record<"fn" | "exec", Record<string, T>>,
  which: "fn" | "exec",
  name: string,
  value: T | undefined,
): Record<"fn" | "exec", Record<string, T>> {
  const bucket = { ...obj[which] };
  if (value === undefined) delete bucket[name];
  else bucket[name] = value;
  return { ...obj, [which]: bucket };
}

function PlaygroundExecution({ prompt, onExecuted }: Props) {
  const stored = useState(() => loadStored(prompt))[0];
  const [functionSelections, setFunctionSelections] = useState<Selections>(
    stored.fn,
  );
  const [executeSelections, setExecuteSelections] = useState<Selections>(
    stored.exec,
  );
  const [layoutChoices, setLayoutChoices] = useState<LayoutChoices>(
    stored.layout,
  );
  const [overwrittenNotes, setOverwrittenNotes] = useState<OverwrittenNotes>({
    fn: {},
    exec: {},
  });
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executeParameters = prompt.executeParameters ?? [];
  const sources = prompt.inputSources;
  const broken = brokenResources(sources);

  const persist = (fn: Selections, exec: Selections, layout: LayoutChoices) => {
    try {
      const collect = (defs: readonly PropDefinition[], sel: Selections) =>
        Object.fromEntries(
          defs.flatMap(d => {
            const input = toExecutionInput(sel[d.name]);
            return input ? [[d.name, input] as const] : [];
          }),
        );
      localStorage.setItem(
        paramStorageKey(prompt),
        JSON.stringify({
          functionInputs: collect(prompt.functionParameters, fn),
          executeInputs: collect(executeParameters, exec),
          layout: { functionSlots: layout.fn, executeSlots: layout.exec },
        } satisfies StoredInputs),
      );
    } catch {
      /* ignore (private browsing, quota, etc.) */
    }
  };

  const change =
    (which: "fn" | "exec") => (name: string, selection: SlotSelection) => {
      const fn =
        which === "fn"
          ? { ...functionSelections, [name]: selection }
          : functionSelections;
      const exec =
        which === "exec"
          ? { ...executeSelections, [name]: selection }
          : executeSelections;
      setFunctionSelections(fn);
      setExecuteSelections(exec);
      persist(fn, exec, layoutChoices);
    };

  /**
   * A slot's effective layout (§B precedence): the user's own stored choice,
   * else `"expanded"` if the stored input's members disagree, else the
   * adapter's hint, else `"expanded"`.
   */
  const layoutFor = (
    which: "fn" | "exec",
    def: PropDefinition,
    groups: readonly FieldGroup[],
  ): InputLayout => {
    const selections = which === "fn" ? functionSelections : executeSelections;
    const hint = (
      which === "fn"
        ? prompt.inputLayout?.functionSlots
        : prompt.inputLayout?.executeSlots
    )?.[def.name];
    return resolveLayout(
      groups,
      toExecutionInput(selections[def.name]),
      layoutChoices[which][def.name],
      hint,
    );
  };

  /**
   * Switch one slot's layout. Forcing a disagreeing slot into combined mode
   * keeps the first member's value and records what it overwrote (§D); the
   * reverse direction is lossless, so nothing else needs to change.
   */
  const toggleLayout = (
    which: "fn" | "exec",
    def: PropDefinition,
    groups: readonly FieldGroup[],
    next: InputLayout,
  ) => {
    let fn = functionSelections;
    let exec = executeSelections;

    if (next === "combined") {
      const selections = which === "fn" ? fn : exec;
      const storedInput = toExecutionInput(selections[def.name]);
      const { selection, overwritten } = collapseLossy(groups, storedInput);
      const merged = fromExecutionInput(expand(groups, selection));
      if (which === "fn") fn = { ...fn, [def.name]: merged };
      else exec = { ...exec, [def.name]: merged };
      setFunctionSelections(fn);
      setExecuteSelections(exec);
      setOverwrittenNotes(prev =>
        withEntry(prev, which, def.name, overwritten),
      );
    } else {
      setOverwrittenNotes(prev => withEntry(prev, which, def.name, undefined));
    }

    const layout = withEntry(layoutChoices, which, def.name, next);
    setLayoutChoices(layout);
    persist(fn, exec, layout);
  };

  /**
   * Assemble the request.
   *
   * Nothing is materialized here. The panel sends recipes and the server
   * resolves them: a resource has no value until the run creates one, and a
   * value whose `functionCall` is bound to an import cannot be resolved in a
   * browser at all.
   *
   * Combined mode never appears here: a combined-mode edit is folded into the
   * fully expanded selection immediately (see {@link toggleLayout} and
   * `CombinedInputEditor`'s `onChange`), so what's stored per slot is always
   * the same per-member tree expanded mode would have produced.
   */
  const buildRequest = (): ExecuteRequest | null => {
    const functionInputs: ExecutionInput[] = [];
    for (const param of prompt.functionParameters) {
      const input = toExecutionInput(functionSelections[param.name]);
      if (!input) {
        if (!param.optional && param.defaultValue === undefined) {
          setError(missingInputMessage(param, !!sources));
          return null;
        }
        functionInputs.push(
          param.defaultValue
            ? { kind: "value", value: param.defaultValue }
            : { kind: "value", value: { kind: "primitive", value: undefined } },
        );
        continue;
      }
      functionInputs.push(input);
    }

    const executeInputs: Record<string, ExecutionInput> = {};
    for (const param of executeParameters) {
      const input = toExecutionInput(executeSelections[param.name]);
      if (!input) {
        if (!param.optional) {
          setError(missingInputMessage(param, !!sources));
          return null;
        }
        continue;
      }
      executeInputs[param.name] = input;
    }

    return { functionInputs, executeInputs };
  };

  const handleRun = async () => {
    setError(null);
    const request = buildRequest();
    if (!request) return;
    setExecuting(true);
    try {
      const result = await executePrompt(prompt, request);
      onExecuted?.({ ...result, label: prompt.name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
    }
  };

  const renderSlots = (
    defs: readonly PropDefinition[],
    selections: Selections,
    slots: Record<string, string[]>,
    which: "fn" | "exec",
  ) =>
    defs.map(def => {
      const groups = fanOutGroups(def);
      const combinable = isCombinable(groups);
      const layout = combinable ? layoutFor(which, def, groups) : "expanded";

      return (
        <div className="pg-exec-param" key={def.name}>
          {/* The control this labels varies by slot — a dropdown, an editor, or
              a hint with nothing focusable at all — so it wraps rather than
              naming an id that may not exist. */}
          <div className="pg-exec-param-label">
            <span className="pg-exec-param-name">
              {def.name}
              {def.optional ? "" : " *"}
            </span>
            <span className="pg-exec-param-type" title={def.type.syntax}>
              {shortSyntax(def.type.syntax, 60)}
            </span>
          </div>
          {def.description && (
            <div className="pg-exec-param-desc">{def.description}</div>
          )}
          {combinable && (
            <div className="pg-combined-toggle">
              <div
                className="pg-layout-tabs"
                role="tablist"
                aria-label={`Layout for ${def.name}`}
              >
                {(["expanded", "combined"] as const).map(option => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={layout === option}
                    className={`pg-layout-tab${
                      layout === option ? " pg-layout-tab-active" : ""
                    }`}
                    onClick={() => toggleLayout(which, def, groups, option)}
                  >
                    {option === "expanded" ? "Expanded" : "Combined"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {layout === "combined" ? (
            <CombinedInputEditor
              propDef={def}
              groups={groups}
              selection={
                collapseLossy(groups, toExecutionInput(selections[def.name]))
                  .selection
              }
              onChange={combined => {
                const nextInput = expand(groups, combined);
                change(which)(def.name, fromExecutionInput(nextInput));
              }}
              resources={sources?.resources ?? []}
              slots={slots}
              overwritten={overwrittenNotes[which][def.name]}
            />
          ) : (
            <ExecutionInputEditor
              propDef={def}
              selection={selections[def.name] ?? {}}
              onChange={selection => change(which)(def.name, selection)}
              resources={sources?.resources ?? []}
              slots={slots}
            />
          )}
        </div>
      );
    });

  return (
    <div className="pg-exec-inner">
      <div className="pg-exec-header">
        <span className="pg-exec-title">Execute</span>
      </div>
      <div className="pg-exec-body">
        {renderSlots(
          prompt.functionParameters,
          functionSelections,
          sources?.functionSlots ?? {},
          "fn",
        )}

        {executeParameters.length > 0 && (
          <>
            <div className="pg-exec-section" />
            {renderSlots(
              executeParameters,
              executeSelections,
              sources?.executeSlots ?? {},
              "exec",
            )}
          </>
        )}

        {broken.map(r => (
          <div className="pg-exec-error" key={r.uri}>
            Playground module <code>{r.uri}</code> failed to load: {r.error}
          </div>
        ))}

        {error && (
          <div className="pg-exec-error">
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
      </div>
      <div className="pg-exec-footer">
        <button
          type="button"
          className="pg-run-btn"
          onClick={handleRun}
          disabled={executing}
        >
          {executing ? "…" : "▶  Run"}
        </button>
      </div>
    </div>
  );
}

function missingInputMessage(
  param: PropDefinition,
  hasSources: boolean,
): string {
  if (param.type.kind !== "opaque") {
    return `Parameter '${param.name}' is required`;
  }
  return hasSources
    ? `Parameter '${param.name}' needs a resource — pick one from its dropdown`
    : `Parameter '${param.name}' is a ${param.type.syntax}, which can't be typed in. ` +
        `Export a resource() from a *.playground.ts beside the prompt, or from ` +
        `.evalution/playground/, to supply one.`;
}

export default PlaygroundExecution;
