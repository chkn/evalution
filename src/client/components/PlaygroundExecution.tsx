// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useRef, useState } from "react";
import { shortSyntax } from "ts-proppy/react";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  InputLayout,
  NormalizedPrompt,
  PropDefinition,
  ResourceInfo,
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
  type ResourceArgs,
  resourceArgsFor,
  type Selections,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";
import {
  computeClaims,
  type ResourceArgsContext,
} from "./resource-args-context";

interface Props {
  prompt: NormalizedPrompt;
  /**
   * Invoked with the trace reference returned by the execute endpoint. Lets
   * the surrounding app open the corresponding trace tab.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
}

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

/**
 * A top-level slot's own unique position — the root every nested
 * {@link ResourceArgsContext.path} within it is built from. Namespaced by
 * `which` so a function parameter and an execute parameter of the same name
 * (a real case — `PromptInputSources.functionSlots` /
 * `executeSlots` are already a parallel split for exactly this reason) don't
 * collide.
 */
function slotPath(which: "fn" | "exec", name: string): string {
  return `${which}.${name}`;
}

/** A stable stand-in for a prompt with no execute parameters, so memos keyed on them hold. */
const NO_PARAMETERS: PropDefinition[] = [];

/** Whether `el` is scrolled short of its bottom edge. */
function hasMoreBelow(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight > 1;
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
 *
 * Arguments ride inside those same stored inputs (a resource node's `args`)
 * rather than in a second key — `resourceArgs` here is *derived*, by pulling
 * every `args` a stored reference carries back out into
 * `specs/resource-arguments.md` §J's shared-by-uri shape, from wherever in
 * the tree it turns up.
 */
function loadStored(prompt: NormalizedPrompt): {
  fn: Selections;
  exec: Selections;
  layout: LayoutChoices;
  resourceArgs: ResourceArgs;
} {
  const empty = {
    fn: {},
    exec: {},
    layout: { fn: {}, exec: {} },
    resourceArgs: {},
  };
  try {
    const raw = localStorage.getItem(paramStorageKey(prompt));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as StoredInputs;
    if (!parsed || typeof parsed !== "object") return empty;
    const resourcesByUri = new Map<string, ResourceInfo>(
      (prompt.inputSources?.resources ?? []).map(r => [r.uri, r]),
    );
    const resourceArgs: ResourceArgs = {};
    const restore = (inputs: Record<string, ExecutionInput> = {}) =>
      Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => {
          const recovered = fromExecutionInput(input, resourcesByUri);
          Object.assign(resourceArgs, recovered.resourceArgs);
          return [name, recovered.selection];
        }),
      );
    return {
      fn: restore(parsed.functionInputs),
      exec: restore(parsed.executeInputs),
      layout: {
        fn: parsed.layout?.functionSlots ?? {},
        exec: parsed.layout?.executeSlots ?? {},
      },
      resourceArgs,
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
  const [resourceArgs, setResourceArgs] = useState<ResourceArgs>(
    stored.resourceArgs,
  );
  const [overwrittenNotes, setOverwrittenNotes] = useState<OverwrittenNotes>({
    fn: {},
    exec: {},
  });
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether `.pg-exec-body` has more content below the fold — cues the
  // shadow above the run error, which otherwise reads as sitting flush
  // against the inputs even though it's actually in the non-scrolling
  // footer below them.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHasMoreBelow, setBodyHasMoreBelow] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setBodyHasMoreBelow(hasMoreBelow(el));
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);

  // The listener above only catches the user's own scrolling — this also
  // re-checks after every render (the first included), so a row appearing, an
  // argument form opening, or the error itself showing up (all of which can
  // change how much of `.pg-exec-body` overflows without the user touching
  // it) keeps the shadow honest too.
  useEffect(() => {
    if (bodyRef.current) setBodyHasMoreBelow(hasMoreBelow(bodyRef.current));
  });

  const executeParameters = prompt.executeParameters ?? NO_PARAMETERS;
  const sources = prompt.inputSources;
  const broken = brokenResources(sources);

  const resourcesByUri = useMemo(
    () =>
      new Map<string, ResourceInfo>(
        (sources?.resources ?? []).map(r => [r.uri, r]),
      ),
    [sources],
  );

  // Panel order — the first slot to reach a given resource `uri` owns its
  // argument form; every later selection of it just points back (§I).
  // Recomputed purely from the current selections on every render (rather
  // than mutated as rows render) so it behaves identically under React
  // StrictMode's double-invoked renders.
  const claimed = useMemo(
    () =>
      computeClaims(
        [
          ...prompt.functionParameters.map(p => ({
            path: slotPath("fn", p.name),
            label: p.name,
            selection: functionSelections[p.name],
          })),
          ...executeParameters.map(p => ({
            path: slotPath("exec", p.name),
            label: p.name,
            selection: executeSelections[p.name],
          })),
        ],
        resourceArgs,
        resourcesByUri,
      ),
    [
      prompt.functionParameters,
      executeParameters,
      functionSelections,
      executeSelections,
      resourceArgs,
      resourcesByUri,
    ],
  );

  const persist = (
    fn: Selections,
    exec: Selections,
    layout: LayoutChoices,
    args: ResourceArgs,
  ) => {
    try {
      const resolveArgs = (uri: string) =>
        resourceArgsFor(uri, args, resourcesByUri);
      const collect = (defs: readonly PropDefinition[], sel: Selections) =>
        Object.fromEntries(
          defs.flatMap(d => {
            const input = toExecutionInput(sel[d.name], resolveArgs);
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
      persist(fn, exec, layoutChoices, resourceArgs);
    };

  const onResourceArgsChange = (uri: string, next: Selections) => {
    const args = { ...resourceArgs, [uri]: next };
    setResourceArgs(args);
    persist(functionSelections, executeSelections, layoutChoices, args);
  };

  // Not itself a valid row's context — `path` is meaningless at this level —
  // but every field *other* than `path` is shared, so each slot spreads this
  // and sets its own `path` (see `renderSlots`) rather than repeating the rest.
  const argsContextBase: Omit<ResourceArgsContext, "path"> = {
    resourceArgs,
    onResourceArgsChange,
    resourceSlots: sources?.resourceSlots ?? {},
    claimed,
    depth: 0,
  };

  /** Builds the `args` a chosen resource should carry, from the current {@link resourceArgs} state. */
  const resolveArgs = (uri: string) =>
    resourceArgsFor(uri, resourceArgs, resourcesByUri);

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
      toExecutionInput(selections[def.name], resolveArgs),
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
      const storedInput = toExecutionInput(selections[def.name], resolveArgs);
      const { selection, overwritten } = collapseLossy(groups, storedInput);
      // Any `args` the round trip carries came from `resourceArgs` itself (via
      // `resolveArgs`), so only the plain selection is needed back out.
      const merged = fromExecutionInput(
        expand(groups, selection, resolveArgs),
      ).selection;
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
    persist(fn, exec, layout, resourceArgs);
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
      const input = toExecutionInput(
        functionSelections[param.name],
        resolveArgs,
      );
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
      const input = toExecutionInput(
        executeSelections[param.name],
        resolveArgs,
      );
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
      const slotArgsContext: ResourceArgsContext = {
        ...argsContextBase,
        path: slotPath(which, def.name),
      };

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
                collapseLossy(
                  groups,
                  toExecutionInput(selections[def.name], resolveArgs),
                ).selection
              }
              onChange={combined =>
                // As in `toggleLayout`: `args` in the round trip are already
                // in `resourceArgs`, edited directly by each row's own form.
                change(which)(
                  def.name,
                  fromExecutionInput(expand(groups, combined, resolveArgs))
                    .selection,
                )
              }
              resources={sources?.resources ?? []}
              slots={slots}
              overwritten={overwrittenNotes[which][def.name]}
              argsContext={slotArgsContext}
            />
          ) : (
            <ExecutionInputEditor
              propDef={def}
              selection={selections[def.name] ?? {}}
              onChange={selection => change(which)(def.name, selection)}
              resources={sources?.resources ?? []}
              slots={slots}
              argsContext={slotArgsContext}
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
      <div className="pg-exec-body" ref={bodyRef}>
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
      </div>
      <div className="pg-exec-footer">
        {/* Above the Run button, not in `.pg-exec-body` — a run's own error
            (as opposed to `broken`, which is about the resources offered
            above, not about running) should stay in view exactly where the
            button that caused it is, not scroll away with the inputs. */}
        {error && (
          <div
            className={
              "pg-exec-error pg-exec-error-run" +
              (bodyHasMoreBelow ? " pg-exec-error-run-shadow" : "")
            }
          >
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
