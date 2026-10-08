// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useState } from "react";
import { shortSyntax } from "ts-proppy/react";
import { fieldsForPrompt } from "../../shared/dataset-fields";
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
  type Selections,
  type SlotSelection,
  type StoredInputs,
  toExecutionInput,
} from "./execution-input-state";
import {
  fromPanel,
  type PanelFill,
  type PanelFillSource,
  type PartialExecuteRequest,
  type SkippedInput,
} from "./named-inputs";
import {
  describePseudoSource,
  withInstanceSources,
  withPseudoSources,
} from "./pseudo-sources";
import {
  type InstanceEdit,
  instanceSourceContext,
  ResourcesSection,
} from "./ResourcesSection";
import {
  fromWireResources,
  type InstanceSelections,
  referencesTo,
  retargetSelections,
  toWireResources,
} from "./run-resources-state";
import { useRunInstances } from "./use-run-instances";

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

/** A stable stand-in for a prompt with no execute parameters, so memos keyed on them hold. */
const NO_PARAMETERS: PropDefinition[] = [];
/** The same, for a prompt with no resources in scope. */
const NO_RESOURCES: ResourceInfo[] = [];

/** `selections` as inputs by slot name, empty slots left out. */
function namedInputs(
  defs: readonly PropDefinition[],
  selections: Selections,
): Record<string, ExecutionInput> {
  return Object.fromEntries(
    defs.flatMap(d => {
      const input = toExecutionInput(selections[d.name]);
      return input ? [[d.name, input] as const] : [];
    }),
  );
}

/** Editor state for a set of stored or recorded inputs, by slot name. */
function restoreSelections(
  inputs: Record<string, ExecutionInput> = {},
): Selections {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [
      name,
      fromExecutionInput(input),
    ]),
  );
}

/**
 * Restore the panel from what was saved last time.
 *
 * An {@link ExecutionInput} is what gets stored, rather than a bare value: a
 * resource choice has no value to save, and storing the recipe is what lets a
 * template come back as a template rather than as the string it flattened to.
 * The run's resource instances are stored beside the slots, as the request
 * sends them.
 */
function loadStored(prompt: NormalizedPrompt): {
  fn: Selections;
  exec: Selections;
  layout: LayoutChoices;
  instances: InstanceSelections;
} {
  const empty = {
    fn: {},
    exec: {},
    layout: { fn: {}, exec: {} },
    instances: {},
  };
  try {
    const raw = localStorage.getItem(paramStorageKey(prompt));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as StoredInputs;
    if (!parsed || typeof parsed !== "object") return empty;
    return {
      fn: restoreSelections(parsed.functionInputs),
      exec: restoreSelections(parsed.executeInputs),
      layout: {
        fn: parsed.layout?.functionSlots ?? {},
        exec: parsed.layout?.executeSlots ?? {},
      },
      instances: fromWireResources(parsed.resources),
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
  const [overwrittenNotes, setOverwrittenNotes] = useState<OverwrittenNotes>({
    fn: {},
    exec: {},
  });
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fillNotice, setFillNotice] = useState<FillNotice | null>(null);

  const executeParameters = prompt.executeParameters ?? NO_PARAMETERS;
  const broken = brokenResources(prompt.inputSources);

  const catalog = prompt.inputSources?.resources ?? NO_RESOURCES;
  const resourcesByUri = useMemo(
    () => new Map<string, ResourceInfo>(catalog.map(r => [r.uri, r])),
    [catalog],
  );
  const { instances, setInstances, adopt } = useRunInstances(
    stored.instances,
    resourcesByUri,
  );

  // The other slots, as sources for `input` references (`specs/evals.md`
  // §B.2.1): offered where their type fits and no cycle would close.
  const bindings = useMemo(() => {
    const resources = toWireResources(instances);
    return {
      functionInputs: namedInputs(
        prompt.functionParameters,
        functionSelections,
      ),
      executeInputs: namedInputs(executeParameters, executeSelections),
      ...(resources && { resources }),
    };
  }, [
    prompt.functionParameters,
    executeParameters,
    functionSelections,
    executeSelections,
    instances,
  ]);
  // Stable while only values change, so typing doesn't remount editors.
  const sources = useStructurallyStable(
    withPseudoSources(withInstanceSources(prompt.inputSources, instances), {
      functionParameters: prompt.functionParameters,
      executeParameters,
      bindings,
    }),
  );

  // Every edit lands in storage, whichever piece of state it changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `bindings` is derived from exactly the state that matters.
  useEffect(() => {
    try {
      localStorage.setItem(
        paramStorageKey(prompt),
        JSON.stringify({
          functionInputs: bindings.functionInputs,
          executeInputs: bindings.executeInputs,
          ...(bindings.resources && { resources: bindings.resources }),
          layout: {
            functionSlots: layoutChoices.fn,
            executeSlots: layoutChoices.exec,
          },
        } satisfies StoredInputs),
      );
    } catch {
      /* ignore (private browsing, quota, etc.) */
    }
  }, [bindings, layoutChoices]);

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
    };

  const changeInstances = (
    next: Parameters<typeof setInstances>[0],
    edit?: InstanceEdit,
  ) => {
    setInstances(next);
    if (!edit) return;
    const [from, to] =
      edit.kind === "rename" ? [edit.from, edit.to] : [edit.name, null];
    setFunctionSelections(s => retargetSelections(s, from, to));
    setExecuteSelections(s => retargetSelections(s, from, to));
  };

  const context = instanceSourceContext({
    instances,
    catalogByUri: resourcesByUri,
    adopt,
    describeOther: (uri, type) =>
      describePseudoSource(uri, type, {
        functionParameters: prompt.functionParameters,
        executeParameters,
      }),
  });

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

    setLayoutChoices(withEntry(layoutChoices, which, def.name, next));
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
      const input = toExecutionInput(functionSelections[param.name]);
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
      const input = toExecutionInput(executeSelections[param.name]);
      if (input) executeInputs[param.name] = input;
      else if (requireAll && !param.optional) {
        setError(missingInputMessage(param, !!prompt.inputSources));
        return null;
      }
    }

    return {
      functionInputs,
      executeInputs,
      ...(bindings.resources && { resources: bindings.resources }),
    };
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
    return {
      functionInputs,
      executeInputs: collected.executeInputs,
      ...(collected.resources && { resources: collected.resources }),
    };
  };

  // Applies a fill once: matched slots overwritten, every other slot left as
  // it was, and the result persisted so a reload shows the filled panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the nonce alone — a fill is a one-shot event, not state to track.
  useEffect(() => {
    if (!fill || appliedFills.has(fill.nonce)) return;
    appliedFills.add(fill.nonce);

    const kept = [
      ...prompt.functionParameters
        .filter(
          p =>
            !(p.name in fill.functionInputs) &&
            toExecutionInput(functionSelections[p.name]),
        )
        .map(p => p.name),
      ...executeParameters
        .filter(
          p =>
            !(p.name in fill.executeInputs) &&
            toExecutionInput(executeSelections[p.name]),
        )
        .map(p => p.name),
    ];

    setFunctionSelections({
      ...functionSelections,
      ...restoreSelections(fill.functionInputs),
    });
    setExecuteSelections({
      ...executeSelections,
      ...restoreSelections(fill.executeInputs),
    });
    // The fill's instances replace any of the same name; the rest stay, as
    // unfilled slots do.
    if (fill.resources) {
      const filled = fromWireResources(fill.resources);
      setInstances(latest => ({ ...latest, ...filled }));
    }
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
              onChange={combined =>
                change(which)(
                  def.name,
                  fromExecutionInput(expand(groups, combined)),
                )
              }
              resources={sources?.resources ?? []}
              slots={slots}
              overwritten={overwrittenNotes[which][def.name]}
              context={context}
            />
          ) : (
            <ExecutionInputEditor
              propDef={def}
              selection={selections[def.name] ?? {}}
              onChange={selection => change(which)(def.name, selection)}
              resources={sources?.resources ?? []}
              slots={slots}
              context={context}
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
            resources={bindings.resources}
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
      {(catalog.length > 0 || Object.keys(instances).length > 0) && (
        <ResourcesSection
          instances={instances}
          onChange={changeInstances}
          sources={sources}
          catalog={catalog}
          referencedBy={name =>
            referencesTo(name, instances, [
              { selections: functionSelections },
              { selections: executeSelections },
            ])
          }
          context={context}
        />
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
