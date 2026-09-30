// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortSyntax } from "ts-proppy/react";
import type { DatasetField } from "../../dataset/dataset-types";
import type {
  EvalArmSpec,
  EvalCheck,
  EvalDefinition,
  EvalDefinitionPatch,
  EvalInputs,
  EvalRunProgress,
  EvalRunSummary,
} from "../../eval/eval-types";
import type {
  CheckInfo,
  DatasetSummary,
  ExecutionInput,
  NormalizedPrompt,
  PropDefinition,
  ResourceInfo,
  VariationInfo,
} from "../../shared/types";
import {
  addDatasetField,
  cancelEvalRun,
  deleteEval,
  EvalRunRefused,
  getChecks,
  getDataset,
  getEval,
  getEvalRuns,
  getPromptVariations,
  getProviderHead,
  startEvalRun,
  updateEval,
} from "../api";
import { useStructurallyStable } from "../hooks/useStructurallyStable";
import { datasetKey } from "./DatasetList";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import { evalProblems, prefillBindings } from "./eval-bindings";
import { formatRate, passRate } from "./eval-summary";
import {
  fromExecutionInput,
  type ResourceArgs,
  readStoredInputs,
  resourceArgsFor,
  type Selections,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";
import { findEvalPrompt } from "./NewEvalDialog";
import {
  checkParameterSources,
  columnUri,
  describePseudoSource,
  NEW_COLUMN_URI,
  withPseudoSources,
} from "./pseudo-sources";
import {
  computeClaims,
  type ResourceArgsContext,
} from "./resource-args-context";
import { formatTimestampCompact } from "./trace/format.ts";
import {
  EvalsIcon,
  PromptLinkIcon,
  DatasetsIcon as SmallDatasetsIcon,
  TrashIcon,
} from "./trace/icons.tsx";
import { useAnchoredPopover } from "./use-anchored-popover";

/** How long after the last edit a change is saved. */
const SAVE_DELAY_MS = 400;

interface Props {
  providerId: string;
  evalId: string;
  prompts: NormalizedPrompt[];
  datasets: DatasetSummary[];
  /** Bumped on every eval change event, so the view refetches. */
  version: number;
  /** Bumped on every dataset change event, so columns stay current. */
  datasetVersion: number;
  /** The latest progress of every run in flight, by run id. */
  progress: Record<string, EvalRunProgress>;
  onOpenRun: (run: EvalRunSummary, evalName: string) => void;
  onOpenPrompt: (prompt: NormalizedPrompt) => void;
  onOpenDataset: (dataset: DatasetSummary) => void;
  onDeleted: () => void;
}

/** Editor state for the eval's bindings, in the execute panel's shape. */
interface EditorState {
  fn: Selections;
  exec: Selections;
  /** Check id → its parameters' selections. */
  checks: Record<string, Selections>;
  /** Shared by every slot and check parameter, as in the panel. */
  args: ResourceArgs;
}

/** Editor state recovered from saved bindings. */
function editorStateOf(
  def: Pick<EvalDefinition, "inputs" | "checks">,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): EditorState {
  const args: ResourceArgs = {};
  const restore = (inputs: Record<string, ExecutionInput>) =>
    Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => {
        const recovered = fromExecutionInput(input, resourcesByUri);
        Object.assign(args, recovered.resourceArgs);
        return [name, recovered.selection];
      }),
    );
  return {
    fn: restore(def.inputs.functionInputs),
    exec: restore(def.inputs.executeInputs),
    checks: Object.fromEntries(def.checks.map(c => [c.id, restore(c.args)])),
    args,
  };
}

/** A new check's id: short, and unique within the eval. */
function mintCheckId(existing: readonly EvalCheck[]): string {
  let n = existing.length + 1;
  while (existing.some(c => c.id === `c${n}`)) n++;
  return `c${n}`;
}

/** The first path in `selection` chosen as "＋ New column", if any. */
function newColumnPath(selection: SlotSelection): string | undefined {
  return Object.entries(selection.resources ?? {}).find(
    ([, uri]) => uri === NEW_COLUMN_URI,
  )?.[0];
}

/**
 * An eval: its prompt, dataset, bindings and checks, edited in place and
 * saved as they change, above its runs. See `specs/evals.md` §F.
 */
function EvalView({
  providerId,
  evalId,
  prompts,
  datasets,
  version,
  datasetVersion,
  progress,
  onOpenRun,
  onOpenPrompt,
  onOpenDataset,
  onDeleted,
}: Props) {
  const [def, setDef] = useState<EvalDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<DatasetField[] | undefined>();
  const [checkInfos, setCheckInfos] = useState<CheckInfo[]>([]);
  const [runs, setRuns] = useState<EvalRunSummary[]>([]);
  const [state, setState] = useState<EditorState>({
    fn: {},
    exec: {},
    checks: {},
    args: {},
  });
  /** Bindings made for the user and not yet touched — see `Prefilled.matched`. */
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  const prompt = def ? findEvalPrompt(prompts, def.prompt) : undefined;
  const dataset =
    def &&
    datasets.find(
      d => d.providerId === def.dataset.providerId && d.id === def.dataset.id,
    );
  const functionParameters = prompt?.functionParameters ?? [];
  const executeParameters = prompt?.executeParameters ?? [];

  const resourcesByUri = useMemo(
    () =>
      new Map<string, ResourceInfo>(
        (prompt?.inputSources?.resources ?? []).map(r => [r.uri, r]),
      ),
    [prompt?.inputSources],
  );

  // ── Loading ────────────────────────────────────────────────────────────

  const loadedId = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on the eval's own change events; the editor state is only reset the first time, so an echo of this view's own save doesn't undo typing in flight.
  useEffect(() => {
    let cancelled = false;
    getEval(providerId, evalId)
      .then(loaded => {
        if (cancelled) return;
        setDef(loaded);
        if (loadedId.current !== evalId) {
          loadedId.current = evalId;
          setName(loaded.name);
          setState(editorStateOf(loaded, resourcesByUri));
        }
      })
      .catch(err => !cancelled && setLoadError(err.message));
    getEvalRuns(providerId, evalId)
      .then(r => !cancelled && setRuns(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [providerId, evalId, version]);

  // A run finishing is an `eval-changed` event too, but progress arrives
  // between them: refetch runs when a run of this eval moves.
  const ownProgress = Object.values(progress).filter(p => p.evalId === evalId);
  const progressKey = ownProgress.map(p => `${p.runId}:${p.done}`).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the progress summary alone.
  useEffect(() => {
    if (!progressKey) return;
    getEvalRuns(providerId, evalId)
      .then(setRuns)
      .catch(() => {});
  }, [progressKey]);

  const datasetProviderId = def?.dataset.providerId;
  const datasetId = def?.dataset.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on the dataset's change events too.
  useEffect(() => {
    if (!datasetProviderId || !datasetId) return;
    getDataset(datasetProviderId, datasetId)
      .then(d => setFields(d.dataset.fields))
      .catch(() => setFields([]));
  }, [datasetProviderId, datasetId, datasetVersion]);

  const promptProviderId = prompt?.providerId;
  useEffect(() => {
    getChecks()
      .then(all =>
        setCheckInfos(
          all.find(p => p.providerId === promptProviderId)?.checks ??
            all[0]?.checks ??
            [],
        ),
      )
      .catch(() => {});
  }, [promptProviderId]);

  // ── Saving ─────────────────────────────────────────────────────────────

  const pending = useRef<EvalDefinitionPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    try {
      setDef(await updateEval(providerId, evalId, patch));
    } catch (err: any) {
      setError(err.message);
    }
  }, [providerId, evalId]);
  useEffect(() => () => void flush(), [flush]);

  const save = (patch: EvalDefinitionPatch, now = false) => {
    pending.current = { ...pending.current, ...patch };
    setDef(d => (d ? { ...d, ...patch } : d));
    clearTimeout(timer.current);
    if (now) void flush();
    else timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  /** The bindings `next` folds to. */
  const foldInputs = (next: EditorState): EvalInputs => {
    const resolve = (uri: string) =>
      resourceArgsFor(uri, next.args, resourcesByUri);
    const fold = (sel: Selections) =>
      Object.fromEntries(
        Object.entries(sel).flatMap(([k, s]) => {
          const input = toExecutionInput(s, resolve);
          return input ? [[k, input] as const] : [];
        }),
      );
    return { functionInputs: fold(next.fn), executeInputs: fold(next.exec) };
  };
  const foldChecks = (next: EditorState, checks: EvalCheck[]): EvalCheck[] => {
    const resolve = (uri: string) =>
      resourceArgsFor(uri, next.args, resourcesByUri);
    return checks.map(c => ({
      ...c,
      args: Object.fromEntries(
        Object.entries(next.checks[c.id] ?? {}).flatMap(([k, s]) => {
          const input = toExecutionInput(s, resolve);
          return input ? [[k, input] as const] : [];
        }),
      ),
    }));
  };

  // The latest state and definition, for a change that lands after an
  // `await` (a new column), when the render's own `state` may be stale.
  const stateRef = useRef(state);
  stateRef.current = state;
  const defRef = useRef(def);
  defRef.current = def;

  const commit = (next: EditorState, checks = defRef.current?.checks ?? []) => {
    stateRef.current = next;
    setState(next);
    save({ inputs: foldInputs(next), checks: foldChecks(next, checks) });
  };

  // ── Pre-filling (§F.1) ─────────────────────────────────────────────────

  const checkIdsKey = def?.checks.map(c => `${c.id}=${c.uri}`).join() ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the prompt, the dataset, or the checks change — never overwriting a binding, so running again is harmless.
  useEffect(() => {
    if (!def || !prompt || !fields) return;
    const current = {
      inputs: foldInputs(state),
      checks: foldChecks(state, def.checks),
    };
    const proposed = prefillBindings({
      prompt,
      fields,
      inputs: current.inputs,
      checks: current.checks,
      checkInfos,
      stored: readStoredInputs(prompt),
    });
    if (proposed.matched.length === 0) return;
    const next = editorStateOf(
      { inputs: proposed.inputs, checks: proposed.checks },
      resourcesByUri,
    );
    setMatched(prev => new Set([...prev, ...proposed.matched]));
    setState(next);
    save({ inputs: proposed.inputs, checks: proposed.checks });
  }, [def?.id, prompt?.id, fields, checkInfos, checkIdsKey]);

  const touch = (key: string) =>
    setMatched(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  // ── Derived ────────────────────────────────────────────────────────────

  const inputs = foldInputs(state);
  const checks = def ? foldChecks(state, def.checks) : [];
  const problems = def
    ? evalProblems(inputs, checks, {
        ...(prompt && { prompt }),
        ...(fields && { fields }),
        checks: checkInfos,
      })
    : [];
  if (def && !prompt) problems.unshift("The eval's prompt no longer exists");
  if (def && !dataset) problems.unshift("The eval's dataset no longer exists");

  // Stable while only values change, so typing doesn't remount editors.
  const sources = useStructurallyStable(
    withPseudoSources(prompt?.inputSources, {
      functionParameters,
      executeParameters,
      bindings: inputs,
      fields: fields ?? [],
      offerMismatches: true,
      newColumn: true,
    }),
  );
  const pseudoOptions = { functionParameters, executeParameters, fields };
  const checkSources = useStructurallyStable(
    Object.fromEntries(
      (def?.checks ?? []).map(c => [
        c.id,
        checkParameterSources(
          checkInfos.find(i => i.uri === c.uri)?.parameters ?? [],
          pseudoOptions,
        ),
      ]),
    ),
  );

  const claimed = computeClaims(
    [
      ...functionParameters.map(p => ({
        path: `fn.${p.name}`,
        label: p.name,
        selection: state.fn[p.name],
      })),
      ...executeParameters.map(p => ({
        path: `exec.${p.name}`,
        label: p.name,
        selection: state.exec[p.name],
      })),
    ],
    state.args,
    resourcesByUri,
  );
  const argsContextFor = (path: string): ResourceArgsContext => ({
    resourceArgs: state.args,
    onResourceArgsChange: (uri, next) =>
      commit({ ...state, args: { ...state.args, [uri]: next } }),
    resourceSlots: sources.resourceSlots ?? {},
    claimed,
    path,
    depth: 0,
    describePseudo: (uri, type) =>
      describePseudoSource(uri, type, pseudoOptions),
  });

  // ── "＋ New column" ───────────────────────────────────────────────────

  /**
   * Adds a column from the slot or check parameter at `from`, then binds
   * `apply` to it — or, when adding it fails, leaves the binding as it was.
   */
  const addColumn = async (
    from:
      | { half: "function" | "execute"; path: string }
      | { checkUri: string; path: string },
    apply: (uri: string | null) => void,
  ) => {
    if (!def || !prompt?.providerId) return apply(null);
    try {
      const field = await addDatasetField(
        def.dataset.providerId,
        def.dataset.id,
        "checkUri" in from
          ? { from: { providerId: prompt.providerId, ...from } }
          : {
              from: {
                providerId: prompt.providerId,
                promptId: prompt.id,
                ...from,
              },
            },
      );
      setFields(prev => [...(prev ?? []), field]);
      apply(columnUri(field.id));
    } catch (err: any) {
      setError(err.message);
      apply(null);
    }
  };

  const changeSlot =
    (which: "fn" | "exec") => (name: string, selection: SlotSelection) => {
      touch(`${which}:${name}`);
      const relPath = newColumnPath(selection);
      const withChoice = (uri: string | null) => {
        const resources = { ...selection.resources };
        if (relPath !== undefined) {
          if (uri) resources[relPath] = uri;
          else delete resources[relPath];
        }
        const prev = stateRef.current;
        commit({
          ...prev,
          [which]: { ...prev[which], [name]: { ...selection, resources } },
        });
      };
      if (relPath === undefined) {
        commit({ ...state, [which]: { ...state[which], [name]: selection } });
        return;
      }
      void addColumn(
        {
          half: which === "fn" ? "function" : "execute",
          path: relPath ? `${name}.${relPath}` : name,
        },
        withChoice,
      );
    };

  const changeCheckParam =
    (check: EvalCheck) => (name: string, selection: SlotSelection) => {
      touch(`check:${check.id}:${name}`);
      const relPath = newColumnPath(selection);
      const set = (sel: SlotSelection) => {
        const prev = stateRef.current;
        commit({
          ...prev,
          checks: {
            ...prev.checks,
            [check.id]: { ...prev.checks[check.id], [name]: sel },
          },
        });
      };
      if (relPath === undefined) return set(selection);
      void addColumn(
        { checkUri: check.uri, path: relPath ? `${name}.${relPath}` : name },
        uri => {
          const resources = { ...selection.resources };
          if (uri) resources[relPath] = uri;
          else delete resources[relPath];
          set({ ...selection, resources });
        },
      );
    };

  const changeCheck = (id: string, patch: Partial<EvalCheck>) => {
    if (!def) return;
    const next = def.checks.map(c => {
      if (c.id !== id) return c;
      const merged = { ...c, ...patch };
      if (patch.threshold === undefined && "threshold" in patch) {
        delete merged.threshold;
      }
      return merged;
    });
    save({ checks: foldChecks(state, next) });
  };

  const addCheck = (uri: string) => {
    if (!def) return;
    const next = [
      ...def.checks,
      { id: mintCheckId(def.checks), uri, args: {} },
    ];
    save({ checks: foldChecks(state, next) }, true);
  };

  const removeCheck = (id: string) => {
    if (!def) return;
    const { [id]: _, ...rest } = state.checks;
    const nextState = { ...state, checks: rest };
    setState(nextState);
    save(
      {
        checks: foldChecks(
          nextState,
          def.checks.filter(c => c.id !== id),
        ),
      },
      true,
    );
  };

  // ── Header actions ─────────────────────────────────────────────────────

  const submitRename = () => {
    setRenaming(false);
    const trimmed = name.trim();
    if (trimmed && def && trimmed !== def.name) save({ name: trimmed }, true);
    else if (def) setName(def.name);
  };

  const handleDelete = async () => {
    if (!def) return;
    if (!window.confirm(`Delete "${def.name}" and all its runs?`)) return;
    try {
      await deleteEval(providerId, evalId);
      onDeleted();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loadError) {
    return <div className="eval-view eval-view-error">Error: {loadError}</div>;
  }
  if (!def) return <div className="eval-view" />;

  const renderSlots = (defs: readonly PropDefinition[], which: "fn" | "exec") =>
    defs.map(param => (
      <div className="pg-exec-param" key={`${which}:${param.name}`}>
        <div className="pg-exec-param-label">
          <span className="pg-exec-param-name">
            {which === "exec" ? `execute.${param.name}` : param.name}
            {param.optional ? "" : " *"}
          </span>
          <span className="pg-exec-param-type" title={param.type.syntax}>
            {shortSyntax(param.type.syntax, 60)}
          </span>
          {matched.has(`${which}:${param.name}`) && (
            <span
              className="eval-matched"
              title="Filled in for you — change it if it's wrong"
            >
              matched
            </span>
          )}
        </div>
        <ExecutionInputEditor
          propDef={param}
          selection={state[which][param.name] ?? {}}
          onChange={selection => changeSlot(which)(param.name, selection)}
          resources={sources.resources}
          slots={which === "fn" ? sources.functionSlots : sources.executeSlots}
          argsContext={argsContextFor(`${which}.${param.name}`)}
        />
      </div>
    ));

  return (
    <div className="eval-view">
      <div className="trace-view-header eval-view-header">
        <div className="trace-view-header-row">
          <div className="trace-view-title">
            <EvalsIcon size={14} />
            {renaming ? (
              <form
                className="dataset-view-rename"
                onSubmit={e => {
                  e.preventDefault();
                  submitRename();
                }}
              >
                <input
                  autoFocus
                  aria-label="Eval name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onFocus={e => e.target.select()}
                  onBlur={submitRename}
                  onKeyDown={e => {
                    if (e.key === "Escape") {
                      setName(def.name);
                      setRenaming(false);
                    }
                  }}
                />
              </form>
            ) : (
              <span
                className="trace-view-name"
                onDoubleClick={() => setRenaming(true)}
                title="Double-click to rename"
              >
                {def.name}
              </span>
            )}
          </div>
          <div className="trace-view-header-actions">
            <button
              type="button"
              className="trace-view-prompt-btn trace-view-delete-btn"
              onClick={handleDelete}
              title="Delete eval"
              aria-label="Delete eval"
            >
              <TrashIcon />
            </button>
          </div>
        </div>
        <div className="trace-view-meta eval-view-pickers">
          <label className="trace-view-meta-item" title="Prompt under test">
            <PromptLinkIcon />
            <select
              className="eval-view-picker"
              aria-label="Prompt"
              value={prompt ? `${prompt.providerId}:${prompt.id}` : ""}
              onChange={e => {
                const next = prompts.find(
                  p => `${p.providerId}:${p.id}` === e.target.value,
                );
                if (next?.providerId) {
                  save(
                    {
                      prompt: {
                        id: next.globalId ?? next.id,
                        providerId: next.providerId,
                      },
                    },
                    true,
                  );
                }
              }}
            >
              {!prompt && <option value="">(missing prompt)</option>}
              {prompts.map(p => (
                <option
                  key={`${p.providerId}:${p.id}`}
                  value={`${p.providerId}:${p.id}`}
                >
                  {p.name}
                </option>
              ))}
            </select>
            {prompt && (
              <button
                type="button"
                className="eval-view-open"
                title="Open the prompt"
                onClick={() => onOpenPrompt(prompt)}
              >
                ↗
              </button>
            )}
          </label>
          <label
            className="trace-view-meta-item"
            title="Dataset whose rows run"
          >
            <SmallDatasetsIcon />
            <select
              className="eval-view-picker"
              aria-label="Dataset"
              value={dataset ? datasetKey(dataset) : ""}
              onChange={e => {
                const next = datasets.find(
                  d => datasetKey(d) === e.target.value,
                );
                if (next) {
                  save(
                    { dataset: { providerId: next.providerId, id: next.id } },
                    true,
                  );
                }
              }}
            >
              {!dataset && <option value="">(missing dataset)</option>}
              {datasets.map(d => (
                <option key={datasetKey(d)} value={datasetKey(d)}>
                  {d.name}
                </option>
              ))}
            </select>
            {dataset && (
              <button
                type="button"
                className="eval-view-open"
                title="Open the dataset"
                onClick={() => onOpenDataset(dataset)}
              >
                ↗
              </button>
            )}
          </label>
        </div>
      </div>

      {error && (
        <div className="pg-exec-error eval-view-action-error">
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

      <div className="eval-view-body">
        <section className="eval-section">
          <h4 className="eval-section-title">Inputs</h4>
          {prompt ? (
            <>
              {renderSlots(functionParameters, "fn")}
              {executeParameters.length > 0 && (
                <>
                  <div className="pg-exec-section" />
                  {renderSlots(executeParameters, "exec")}
                </>
              )}
              {functionParameters.length + executeParameters.length === 0 && (
                <p className="eval-empty">This prompt takes no inputs.</p>
              )}
            </>
          ) : (
            <p className="eval-empty">Choose a prompt above.</p>
          )}
        </section>

        <section className="eval-section">
          <h4 className="eval-section-title">Checks</h4>
          {def.checks.map(check => (
            <CheckEditor
              key={check.id}
              check={check}
              info={checkInfos.find(c => c.uri === check.uri)}
              selections={state.checks[check.id] ?? {}}
              onChange={changeCheckParam(check)}
              onChangeCheck={patch => changeCheck(check.id, patch)}
              onRemove={() => removeCheck(check.id)}
              sources={checkSources[check.id] ?? {}}
              argsContextFor={argsContextFor}
              matched={matched}
            />
          ))}
          <AddCheckMenu checks={checkInfos} onAdd={addCheck} />
        </section>

        <section className="eval-section">
          {problems.length > 0 && (
            <ul className="eval-problems" aria-label="Problems">
              {problems.map(p => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <RunControl
            prompt={prompt}
            disabled={problems.length > 0}
            onRun={async options => {
              await flush();
              try {
                // The run's own change event refetches the runs list.
                await startEvalRun(providerId, evalId, options);
              } catch (err: any) {
                setError(
                  err instanceof EvalRunRefused
                    ? `Can't run: ${err.problems.join("; ")}`
                    : err.message,
                );
              }
            }}
          />
        </section>

        <section className="eval-section">
          <h4 className="eval-section-title">Runs</h4>
          {runs.length === 0 ? (
            <p className="eval-empty">No runs yet.</p>
          ) : (
            <RunList
              runs={runs}
              progress={progress}
              onOpen={run => onOpenRun(run, def.name)}
              onCancel={run =>
                cancelEvalRun(providerId, run.id).catch(err =>
                  setError(err.message),
                )
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** One check in the editor: its parameters, threshold, and a remove button. */
function CheckEditor({
  check,
  info,
  selections,
  onChange,
  onChangeCheck,
  onRemove,
  sources,
  argsContextFor,
  matched,
}: {
  check: EvalCheck;
  info: CheckInfo | undefined;
  selections: Selections;
  onChange: (name: string, selection: SlotSelection) => void;
  onChangeCheck: (patch: Partial<EvalCheck>) => void;
  onRemove: () => void;
  sources: ReturnType<typeof checkParameterSources>;
  argsContextFor: (path: string) => ResourceArgsContext;
  matched: ReadonlySet<string>;
}) {
  return (
    <div className="eval-check">
      <div className="eval-check-header">
        <span className="eval-check-label" title={check.uri}>
          {check.label ?? info?.label ?? check.uri}
        </span>
        {info?.group && <span className="eval-check-group">{info.group}</span>}
        <button
          type="button"
          className="pg-dismiss eval-check-remove"
          title="Remove check"
          aria-label={`Remove ${check.label ?? info?.label ?? check.uri}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {info?.description && (
        <div className="pg-exec-param-desc">{info.description}</div>
      )}
      {!info && (
        <div className="eval-check-missing">This check no longer exists.</div>
      )}
      {info?.error && <div className="eval-check-missing">{info.error}</div>}
      {info?.parameters.map(param => (
        <div className="pg-exec-param" key={param.name}>
          <div className="pg-exec-param-label">
            <span className="pg-exec-param-name">
              {param.name}
              {param.optional ? "" : " *"}
            </span>
            <span className="pg-exec-param-type" title={param.type.syntax}>
              {shortSyntax(param.type.syntax, 60)}
            </span>
            {matched.has(`check:${check.id}:${param.name}`) && (
              <span className="eval-matched" title="Filled in for you">
                matched
              </span>
            )}
          </div>
          <ExecutionInputEditor
            propDef={param}
            selection={selections[param.name] ?? {}}
            onChange={selection => onChange(param.name, selection)}
            resources={sources.resources}
            slots={sources.functionSlots}
            argsContext={argsContextFor(`check.${check.id}.${param.name}`)}
          />
        </div>
      ))}
      <label className="eval-check-threshold">
        <span>Pass at score ≥</span>
        <input
          type="number"
          step="any"
          placeholder="—"
          aria-label="Threshold"
          value={check.threshold ?? ""}
          onChange={e =>
            onChangeCheck({
              threshold:
                e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
        />
      </label>
    </div>
  );
}

/** "＋ Add check": the checks on offer, grouped like the resource picker, built-ins first. */
function AddCheckMenu({
  checks,
  onAdd,
}: {
  checks: readonly CheckInfo[];
  onAdd: (uri: string) => void;
}) {
  const groups = new Map<string, CheckInfo[]>();
  for (const c of checks) {
    if (c.error) continue;
    const group = c.group ?? "Playground";
    groups.set(group, [...(groups.get(group) ?? []), c]);
  }
  const broken = checks.filter(c => c.error);
  return (
    <div className="eval-add-check">
      <select
        aria-label="Add check"
        value=""
        onChange={e => e.target.value && onAdd(e.target.value)}
      >
        <option value="">＋ Add check…</option>
        {[...groups].map(([group, members]) => (
          <optgroup key={group} label={group}>
            {members.map(c => (
              <option key={c.uri} value={c.uri} title={c.description}>
                {c.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {broken.map(c => (
        <div className="pg-exec-error" key={c.uri}>
          <code>{c.uri}</code> failed to load: {c.error}
        </div>
      ))}
    </div>
  );
}

/**
 * The Run button, with its arms selector: Working tree, plus Unsaved edits
 * when the prompt has some, and any named variation. Warns first when the
 * tree has uncommitted changes, or there's no git to pin results to.
 */
function RunControl({
  prompt,
  disabled,
  onRun,
}: {
  prompt: NormalizedPrompt | undefined;
  disabled: boolean;
  onRun: (options: {
    arms: EvalArmSpec[];
    concurrency: number;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [variations, setVariations] = useState<VariationInfo[]>([]);
  const [head, setHead] = useState<{ versioned: boolean; clean: boolean }>();
  const [chosen, setChosen] = useState<Set<string>>(new Set(["head"]));
  const [concurrency, setConcurrency] = useState(4);
  const [busy, setBusy] = useState(false);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: () => setOpen(false),
      matchTriggerWidth: false,
    });

  const wip = variations.find(v => v.wip && v.onHead);
  const named = variations.filter(v => !v.wip && v.names.length > 0);

  const openDialog = async () => {
    setOpen(true);
    if (!prompt?.providerId) return;
    const [vs, h] = await Promise.all([
      getPromptVariations(prompt).catch(() => []),
      getProviderHead(prompt.providerId).catch(() => undefined),
    ]);
    setVariations(vs);
    setHead(h);
    // Unsaved edits are pre-selected when there are some: the tight loop is
    // "edit, run the eval, compare".
    if (vs.some(v => v.wip && v.onHead)) {
      setChosen(prev => new Set([...prev, "wip"]));
    }
  };

  const toggle = (key: string) =>
    setChosen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const arms: EvalArmSpec[] = [
    ...(chosen.has("head") ? [{ kind: "head" } as const] : []),
    ...(wip && chosen.has("wip")
      ? [{ kind: "wip", variation: wip.id } as const]
      : []),
    ...named
      .filter(v => chosen.has(v.id))
      .map(v => ({
        kind: "variation" as const,
        variation: v.id,
        label: v.names[0],
      })),
  ];

  return (
    <div className="eval-run-control">
      <button
        ref={triggerRef}
        type="button"
        className="pg-run-btn"
        disabled={disabled}
        title={disabled ? "Fix the problems above to run" : undefined}
        onClick={() => (open ? setOpen(false) : void openDialog())}
      >
        ▶ Run ▾
      </button>
      {open &&
        createPortal(
          <div className="eval-run-dialog" ref={popoverRef} style={style}>
            <div className="eval-run-dialog-title">Run against</div>
            <label>
              <input
                type="checkbox"
                checked={chosen.has("head")}
                onChange={() => toggle("head")}
              />
              Working tree
            </label>
            {wip && (
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has("wip")}
                  onChange={() => toggle("wip")}
                />
                Unsaved edits
              </label>
            )}
            {named.map(v => (
              <label key={v.id}>
                <input
                  type="checkbox"
                  checked={chosen.has(v.id)}
                  onChange={() => toggle(v.id)}
                />
                {v.names[0]}
              </label>
            ))}
            <label className="eval-run-concurrency">
              At once
              <input
                type="number"
                min={1}
                value={concurrency}
                onChange={e =>
                  setConcurrency(Math.max(1, Number(e.target.value) || 1))
                }
              />
            </label>
            {head && !head.versioned && (
              <p className="eval-run-warning">
                There's no git here, so results won't record a version.
              </p>
            )}
            {head?.versioned && !head.clean && (
              <p className="eval-run-warning">
                You have uncommitted changes. Results won't be reproducible;
                commit first to pin them to a version.
              </p>
            )}
            <button
              type="button"
              className="dialog-btn-create"
              disabled={busy || arms.length === 0}
              onClick={async () => {
                setBusy(true);
                await onRun({ arms, concurrency });
                setBusy(false);
                setOpen(false);
              }}
            >
              Start run
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** The eval's runs, newest first, with live progress for those in flight. */
function RunList({
  runs,
  progress,
  onOpen,
  onCancel,
}: {
  runs: EvalRunSummary[];
  progress: Record<string, EvalRunProgress>;
  onOpen: (run: EvalRunSummary) => void;
  onCancel: (run: EvalRunSummary) => void;
}) {
  return (
    <table className="eval-runs">
      <tbody>
        {runs.map(run => {
          const live = progress[run.id];
          const status = live?.status ?? run.status;
          const counts = live?.counts ?? run.counts;
          const done = live?.done ?? run.done;
          return (
            <tr
              key={run.id}
              className="eval-run-row"
              onClick={() => onOpen(run)}
            >
              <td>{formatTimestampCompact(run.startedAt)}</td>
              <td>{run.arms.map(a => a.label).join(" · ")}</td>
              <td>
                {status === "running" ? (
                  <>
                    <progress max={run.total} value={done} /> {done}/{run.total}
                  </>
                ) : (
                  <span className={`eval-status eval-status-${status}`}>
                    {status === "done"
                      ? `${formatRate(passRate(counts))} passing`
                      : status}
                  </span>
                )}
              </td>
              <td className="eval-run-counts">
                {counts.fail > 0 && (
                  <span className="eval-count-fail">{counts.fail} failed</span>
                )}
                {counts.error > 0 && (
                  <span className="eval-count-error">
                    {counts.error} errors
                  </span>
                )}
              </td>
              <td className="eval-run-badges">
                {run.dirty && (
                  <span
                    className="eval-badge"
                    title="Run with uncommitted changes"
                  >
                    uncommitted changes
                  </span>
                )}
                {run.drifted && (
                  <span
                    className="eval-badge"
                    title="The working tree changed mid-run"
                  >
                    drifted
                  </span>
                )}
                {status === "running" && (
                  <button
                    type="button"
                    className="dialog-btn-cancel"
                    onClick={e => {
                      e.stopPropagation();
                      onCancel(run);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default EvalView;
