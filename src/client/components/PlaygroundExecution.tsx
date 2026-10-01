// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useState } from "react";
import { shortSyntax } from "ts-proppy/react";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  InputLayout,
  NormalizedPrompt,
  PromptRef,
  PropDefinition,
  ResourceInfo,
} from "../../shared/types";
import { executePrompt } from "../api";
import { useStructurallyStable } from "../hooks/useStructurallyStable";
import { AddToDatasetMenu } from "./AddToDatasetMenu";
import { CombinedInputEditor } from "./CombinedInputEditor";
import {
  collapseLossy,
  expand,
  type FieldGroup,
  fanOutGroups,
  isCombinable,
  resolveLayout,
} from "./combined-inputs";
import { ExecPanelShell } from "./ExecPanelShell";
import { brokenResources, ExecutionInputEditor } from "./ExecutionInputEditor";
import {
  fromExecutionInput,
  paramStorageKey,
  type ResourceArgs,
  resourceArgsFor,
  type Selections,
  type SlotSelection,
  type StoredInputs,
  toExecutionInput,
} from "./execution-input-state";
import {
  fieldsForPrompt,
  fromPanel,
  type PanelFill,
  type PanelFillSource,
  type PartialExecuteRequest,
  type SkippedInput,
} from "./named-inputs";
import { describePseudoSource, withPseudoSources } from "./pseudo-sources";
import {
  computeClaims,
  type ResourceArgsContext,
} from "./resource-args-context";

interface Props {
  prompt: NormalizedPrompt;
  /** The version or variation to run, when not head. */
  promptRef?: PromptRef;
  /** Why running is unavailable here (an old version, say), if it is. */
  runDisabledReason?: string;
  /**
   * Invoked with the trace reference returned by the execute endpoint. Lets
   * the surrounding app open the corresponding trace tab.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
  /**
   * A one-shot request to overwrite the panel — from a trace or a dataset
   * row. Applied once per `nonce`, then persisted like any other edit.
   */
  fill?: PanelFill;
  /** Opens where a fill came from. Without it, the notice names the source as plain text. */
  onOpenFillSource?: (from: PanelFillSource) => void;
}

/**
 * Fill nonces already applied, page-wide — so a panel that remounts (its tab
 * dragged to another pane, say) doesn't re-apply a fill over edits made
 * since.
 */
const appliedFills = new Set<number>();

/** What the notice under the header says after a fill. */
interface FillNotice {
  from: PanelFillSource;
  /** Slots that kept the user's own value because the fill had none for them. */
  kept: string[];
  skipped: SkippedInput[];
}

function skipMessage({ name, reason }: SkippedInput) {
  return (
    <>
      <code>{name}</code>
      {reason === "resource-out-of-scope"
        ? " uses a resource this prompt can't see"
        : " has no matching parameter"}
    </>
  );
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

function PlaygroundExecution({
  prompt,
  promptRef,
  runDisabledReason,
  onExecuted,
  fill,
  onOpenFillSource,
}: Props) {
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
  const [fillNotice, setFillNotice] = useState<FillNotice | null>(null);

  const executeParameters = prompt.executeParameters ?? NO_PARAMETERS;
  const broken = brokenResources(prompt.inputSources);

  const resourcesByUri = useMemo(
    () =>
      new Map<string, ResourceInfo>(
        (prompt.inputSources?.resources ?? []).map(r => [r.uri, r]),
      ),
    [prompt.inputSources],
  );

  // The other slots, as sources for `input` references (`specs/evals.md`
  // §B.2.1): offered where their type fits and no cycle would close.
  const bindings = useMemo(() => {
    const resolve = (uri: string) =>
      resourceArgsFor(uri, resourceArgs, resourcesByUri);
    const named = (defs: readonly PropDefinition[], sel: Selections) =>
      Object.fromEntries(
        defs.flatMap(d => {
          const input = toExecutionInput(sel[d.name], resolve);
          return input ? [[d.name, input] as const] : [];
        }),
      );
    return {
      functionInputs: named(prompt.functionParameters, functionSelections),
      executeInputs: named(executeParameters, executeSelections),
    };
  }, [
    prompt.functionParameters,
    executeParameters,
    functionSelections,
    executeSelections,
    resourceArgs,
    resourcesByUri,
  ]);
  // Stable while only values change, so typing doesn't remount editors.
  const sources = useStructurallyStable(
    withPseudoSources(prompt.inputSources, {
      functionParameters: prompt.functionParameters,
      executeParameters,
      bindings,
    }),
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
    resourceSlots: sources.resourceSlots ?? {},
    claimed,
    depth: 0,
    describePseudo: (uri, type) =>
      describePseudoSource(uri, type, {
        functionParameters: prompt.functionParameters,
        executeParameters,
      }),
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
   * Gather the panel's inputs, by slot name.
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
   *
   * @param requireAll - Whether an empty required slot is an error (for a
   *   run), or simply absent (for a dataset row, where a partial row is
   *   legitimate). Returns `null`, having set the error, only in the former.
   */
  const collectInputs = ({
    requireAll,
  }: {
    requireAll: boolean;
  }): PartialExecuteRequest | null => {
    const functionInputs: Record<string, ExecutionInput> = {};
    for (const param of prompt.functionParameters) {
      const input = toExecutionInput(
        functionSelections[param.name],
        resolveArgs,
      );
      if (input) functionInputs[param.name] = input;
      else if (
        requireAll &&
        !param.optional &&
        param.defaultValue === undefined
      ) {
        setError(missingInputMessage(param, !!prompt.inputSources));
        return null;
      }
    }

    const executeInputs: Record<string, ExecutionInput> = {};
    for (const param of executeParameters) {
      const input = toExecutionInput(
        executeSelections[param.name],
        resolveArgs,
      );
      if (input) executeInputs[param.name] = input;
      else if (requireAll && !param.optional) {
        setError(missingInputMessage(param, !!prompt.inputSources));
        return null;
      }
    }

    return { functionInputs, executeInputs };
  };

  /** The request to run: every slot, positionally, defaults filled in. */
  const buildRequest = (): ExecuteRequest | null => {
    const collected = collectInputs({ requireAll: true });
    if (!collected) return null;
    const functionInputs = prompt.functionParameters.map(
      (param): ExecutionInput =>
        collected.functionInputs[param.name] ??
        (param.defaultValue
          ? { kind: "value", value: param.defaultValue }
          : { kind: "value", value: { kind: "primitive", value: undefined } }),
    );
    return { functionInputs, executeInputs: collected.executeInputs };
  };

  // Applies a fill once: matched slots overwritten, every other slot left as
  // it was, and the result persisted so a reload shows the filled panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the nonce alone — a fill is a one-shot event, not state to track.
  useEffect(() => {
    if (!fill || appliedFills.has(fill.nonce)) return;
    appliedFills.add(fill.nonce);

    const recoveredArgs: ResourceArgs = {};
    const restore = (inputs: Record<string, ExecutionInput>) =>
      Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => {
          const recovered = fromExecutionInput(input, resourcesByUri);
          Object.assign(recoveredArgs, recovered.resourceArgs);
          return [name, recovered.selection];
        }),
      );
    const kept = [
      ...prompt.functionParameters
        .filter(
          p =>
            !(p.name in fill.functionInputs) &&
            toExecutionInput(functionSelections[p.name], resolveArgs),
        )
        .map(p => p.name),
      ...executeParameters
        .filter(
          p =>
            !(p.name in fill.executeInputs) &&
            toExecutionInput(executeSelections[p.name], resolveArgs),
        )
        .map(p => p.name),
    ];

    const fn = { ...functionSelections, ...restore(fill.functionInputs) };
    const exec = { ...executeSelections, ...restore(fill.executeInputs) };
    const args = { ...resourceArgs, ...recoveredArgs };
    setFunctionSelections(fn);
    setExecuteSelections(exec);
    setResourceArgs(args);
    persist(fn, exec, layoutChoices, args);
    setFillNotice({ from: fill.from, kept, skipped: fill.skipped });
  }, [fill?.nonce]);

  // What "Add to dataset" would add: the filled slots, required or not.
  const panelInputs = fromPanel(
    prompt,
    collectInputs({ requireAll: false }) ?? {
      functionInputs: {},
      executeInputs: {},
    },
  );

  const handleRun = async () => {
    setError(null);
    const request = buildRequest();
    if (!request) return;
    setExecuting(true);
    try {
      const result = await executePrompt(prompt, request, promptRef);
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
    <ExecPanelShell
      title="Execute"
      actions={
        prompt.providerId && (
          <AddToDatasetMenu
            inputs={panelInputs}
            newDatasetFields={fieldsForPrompt(prompt)}
            prompt={{
              link: {
                id: prompt.globalId ?? prompt.id,
                providerId: prompt.providerId,
              },
              openable: { id: prompt.id, providerId: prompt.providerId },
            }}
            source={{
              kind: "playground",
              promptId: prompt.id,
              providerId: prompt.providerId,
            }}
            disabled={panelInputs.length === 0}
          />
        )
      }
      error={error}
      onDismissError={() => setError(null)}
      footer={
        <button
          type="button"
          className="pg-run-btn"
          onClick={handleRun}
          disabled={executing || !!runDisabledReason}
          title={runDisabledReason}
        >
          {executing ? "…" : "▶  Run"}
        </button>
      }
    >
      {fillNotice && (
        <div className="pg-exec-fill-notice" role="status">
          <span>
            Filled from{" "}
            {onOpenFillSource ? (
              <button
                type="button"
                className="pg-exec-fill-link"
                onClick={e => {
                  // Otherwise this bubbles to the pane's own onClick,
                  // which refocuses *this* pane right back — undoing the
                  // jump just made.
                  e.stopPropagation();
                  onOpenFillSource(fillNotice.from);
                }}
                title={fillNotice.from.description}
              >
                {fillNotice.from.type} ↗
              </button>
            ) : (
              fillNotice.from.type
            )}
            {fillNotice.kept.length > 0 && (
              <>
                <br />
                {"Not filled: "}
                {fillNotice.kept.map((name, i) => (
                  <span key={name}>
                    {i > 0 && ", "}
                    <code>{name}</code>
                  </span>
                ))}
              </>
            )}
          </span>
          {fillNotice.skipped.map(skip => (
            <span key={skip.name} className="pg-exec-fill-skipped">
              {skipMessage(skip)}
            </span>
          ))}
          <button
            type="button"
            className="pg-dismiss"
            aria-label="Dismiss"
            onClick={() => setFillNotice(null)}
          >
            ×
          </button>
        </div>
      )}
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
    </ExecPanelShell>
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
