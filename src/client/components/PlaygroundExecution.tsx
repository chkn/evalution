// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { shortSyntax } from "ts-proppy/react";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  NormalizedPrompt,
  PropDefinition,
} from "../../shared/types";
import { executePrompt } from "../api";
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

/** What is persisted between sessions: the inputs themselves, not the values. */
interface StoredInputs {
  functionInputs?: Record<string, ExecutionInput>;
  executeInputs?: Record<string, ExecutionInput>;
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
} {
  const empty = { fn: {}, exec: {} };
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
    };
  } catch {
    /* ignore (private browsing, quota, corrupt entry, etc.) */
    return empty;
  }
}

function PlaygroundExecution({ prompt, onExecuted }: Props) {
  const stored = useState(() => loadStored(prompt))[0];
  const [functionSelections, setFunctionSelections] = useState<Selections>(
    stored.fn,
  );
  const [executeSelections, setExecuteSelections] = useState<Selections>(
    stored.exec,
  );
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executeParameters = prompt.executeParameters ?? [];
  const sources = prompt.inputSources;
  const broken = brokenResources(sources);

  const persist = (fn: Selections, exec: Selections) => {
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
      persist(fn, exec);
    };

  /**
   * Assemble the request.
   *
   * Nothing is materialized here. The panel sends recipes and the server
   * resolves them: a resource has no value until the run creates one, and a
   * value whose `functionCall` is bound to an import cannot be resolved in a
   * browser at all.
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
    defs.map(def => (
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
        <ExecutionInputEditor
          propDef={def}
          selection={selections[def.name] ?? {}}
          onChange={selection => change(which)(def.name, selection)}
          resources={sources?.resources ?? []}
          slots={slots}
        />
      </div>
    ));

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
