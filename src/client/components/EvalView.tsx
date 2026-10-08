// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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
import type { AgentInfo } from "../../shared/agent";
import type {
  CheckInfo,
  DatasetSummary,
  ExecutionInput,
  NormalizedPrompt,
  PromptInputSources,
  PropDefinition,
  ResourceInfo,
  VariationInfo,
} from "../../shared/types";
import {
  addDatasetField,
  cancelEvalRun,
  deleteEval,
  deleteEvalRun,
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
import { AskAgentButton } from "./AskAgentButton";
import { datasetKey } from "./DatasetList";
import { ExecPanelShell, PromptSplit } from "./ExecPanelShell";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import { evalProblems, prefillBindings } from "./eval-bindings";
import { deleteRunQuestion, formatRate, passRate } from "./eval-summary";
import {
  fromExecutionInput,
  readStoredInputs,
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
  withInstanceSources,
  withPseudoSources,
} from "./pseudo-sources";
import {
  type InstanceEdit,
  instanceSourceContext,
  ResourcesSection,
} from "./ResourcesSection";
import {
  adoptCatalogPick,
  fromWireResources,
  type InstanceSelections,
  referencesTo,
  retargetSelections,
  toWireResources,
} from "./run-resources-state";
import { formatTimestampCompact } from "./trace/format.ts";
import {
  PromptLinkIcon,
  DatasetsIcon as SmallDatasetsIcon,
  TrashIcon,
} from "./trace/icons.tsx";

/** Sources for a check with none: no resources, no slots. */
const EMPTY_SOURCES: PromptInputSources = {
  resources: [],
  functionSlots: {},
  executeSlots: {},
};

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
  /** Called once one of the eval's runs is deleted, so its tab can close. */
  onRunDeleted: (run: EvalRunSummary) => void;
  /** Coding agents the "Ask" button offers. */
  agents?: readonly AgentInfo[];
  /**
   * Launches a coding agent about this eval. Without it (or without
   * `agents`), there's no "Ask" button.
   */
  onAskAgent?: (agent: AgentInfo) => void;
}

/** Editor state for the eval's bindings, in the execute panel's shape. */
interface EditorState {
  fn: Selections;
  exec: Selections;
  /** Check id → its parameters' selections. */
  checks: Record<string, Selections>;
  /**
   * The eval's own resource instances, which every row gets — a row's own
   * instance of the same name wins (`specs/resource-instances.md` §E).
   */
  instances: InstanceSelections;
}

/** Editor state recovered from saved bindings. */
function editorStateOf(
  def: Pick<EvalDefinition, "inputs" | "checks">,
): EditorState {
  const restore = (inputs: Record<string, ExecutionInput>) =>
    Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [
        name,
        fromExecutionInput(input),
      ]),
    );
  return {
    fn: restore(def.inputs.functionInputs),
    exec: restore(def.inputs.executeInputs),
    checks: Object.fromEntries(def.checks.map(c => [c.id, restore(c.args)])),
    instances: fromWireResources(def.inputs.resources),
  };
}

/** `selections` as inputs by name, empty ones left out. */
function foldSelections(
  selections: Selections,
): Record<string, ExecutionInput> {
  return Object.fromEntries(
    Object.entries(selections).flatMap(([k, s]) => {
      const input = toExecutionInput(s);
      return input ? [[k, input] as const] : [];
    }),
  );
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
  onRunDeleted,
  agents = [],
  onAskAgent,
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
    instances: {},
  });
  /** Bindings made for the user and not yet touched — see `Prefilled.matched`. */
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  const prompt = def ? findEvalPrompt(prompts, def.prompt) : undefined;
  const runChoices = useRunChoices(prompt);
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
          const loadedState = editorStateOf(loaded);
          stateRef.current = loadedState;
          setState(loadedState);
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
    const resources = toWireResources(next.instances);
    return {
      functionInputs: foldSelections(next.fn),
      executeInputs: foldSelections(next.exec),
      ...(resources && { resources }),
    };
  };
  const foldChecks = (next: EditorState, checks: EvalCheck[]): EvalCheck[] =>
    checks.map(c => ({ ...c, args: foldSelections(next.checks[c.id] ?? {}) }));

  // The latest state and definition, for a change that lands after an
  // `await` (a new column), when the render's own `state` may be stale.
  const stateRef = useRef(state);
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
    const next = editorStateOf({
      inputs: proposed.inputs,
      checks: proposed.checks,
    });
    setMatched(prev => new Set([...prev, ...proposed.matched]));
    stateRef.current = next;
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
    withPseudoSources(
      withInstanceSources(prompt?.inputSources, state.instances),
      {
        functionParameters,
        executeParameters,
        bindings: inputs,
        fields: fields ?? [],
        offerMismatches: true,
        newColumn: true,
      },
    ),
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

  const changeInstances = (
    next:
      | InstanceSelections
      | ((latest: InstanceSelections) => InstanceSelections),
    edit?: InstanceEdit,
  ) => {
    const prev = stateRef.current;
    const instances = typeof next === "function" ? next(prev.instances) : next;
    if (!edit) return commit({ ...prev, instances });
    const [from, to] =
      edit.kind === "rename" ? [edit.from, edit.to] : [edit.name, null];
    commit({
      fn: retargetSelections(prev.fn, from, to),
      exec: retargetSelections(prev.exec, from, to),
      checks: Object.fromEntries(
        Object.entries(prev.checks).map(([id, sel]) => [
          id,
          retargetSelections(sel, from, to),
        ]),
      ),
      instances,
    });
  };
  const context = instanceSourceContext({
    instances: state.instances,
    catalogByUri: resourcesByUri,
    adopt: uri => {
      const picked = adoptCatalogPick(
        stateRef.current.instances,
        uri,
        resourcesByUri,
      );
      changeInstances(picked.instances);
      return picked.uri;
    },
    describeOther: (uri, type) =>
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
        const prev = stateRef.current;
        commit({ ...prev, [which]: { ...prev[which], [name]: selection } });
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
    stateRef.current = nextState;
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

  const handleDeleteRun = async (run: EvalRunSummary) => {
    const running = (progress[run.id]?.status ?? run.status) === "running";
    if (!window.confirm(deleteRunQuestion(run.startedAt, running))) return;
    try {
      await deleteEvalRun(providerId, run.id);
      setRuns(prev => prev.filter(r => r.id !== run.id));
      onRunDeleted(run);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loadError) {
    return <div className="eval-view eval-view-error">Error: {loadError}</div>;
  }
  if (!def) return <div className="eval-view" />;

  /** One field of the Inputs panel: a prompt slot or a check's parameter. */
  const renderField = (
    param: PropDefinition,
    {
      key,
      label,
      matchedKey,
      selection,
      onChange,
      sources: from,
      slots,
    }: {
      key: string;
      label: string;
      matchedKey: string;
      selection: SlotSelection;
      onChange: (selection: SlotSelection) => void;
      sources: PromptInputSources;
      slots: PromptInputSources["functionSlots"];
    },
  ) => (
    <div className="pg-exec-param" key={key}>
      <div className="pg-exec-param-label">
        <span className="pg-exec-param-name">
          {label}
          {param.optional ? "" : " *"}
        </span>
        <span className="pg-exec-param-type" title={param.type.syntax}>
          {shortSyntax(param.type.syntax, 60)}
        </span>
        {matched.has(matchedKey) && (
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
        selection={selection}
        onChange={onChange}
        resources={from.resources}
        slots={slots}
        context={context}
      />
    </div>
  );

  const renderSlots = (defs: readonly PropDefinition[], which: "fn" | "exec") =>
    defs.map(param =>
      renderField(param, {
        key: `${which}:${param.name}`,
        label: which === "exec" ? `execute.${param.name}` : param.name,
        matchedKey: `${which}:${param.name}`,
        selection: state[which][param.name] ?? {},
        onChange: selection => changeSlot(which)(param.name, selection),
        sources,
        slots: which === "fn" ? sources.functionSlots : sources.executeSlots,
      }),
    );

  const header = (
    <div className="pg-prompt-header eval-header">
      <div className="pg-prompt-header-row">
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
            className="pg-prompt-name"
            onDoubleClick={() => setRenaming(true)}
            title="Double-click to rename"
          >
            {def.name}
          </span>
        )}
        <div className="pg-prompt-header-right">
          {error && (
            <div className="pg-header-error">
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
          {onAskAgent && <AskAgentButton agents={agents} onAsk={onAskAgent} />}
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
      <div className="eval-header-links">
        <button
          type="button"
          className="eval-header-link"
          disabled={!prompt}
          title="Open the prompt"
          onClick={() => prompt && onOpenPrompt(prompt)}
        >
          <PromptLinkIcon />
          <span className="eval-header-link-name">
            {prompt?.name ?? "Prompt missing"}
          </span>
          {prompt && "↗"}
        </button>
        <button
          type="button"
          className="eval-header-link"
          disabled={!dataset}
          title="Open the dataset"
          onClick={() => dataset && onOpenDataset(dataset)}
        >
          <SmallDatasetsIcon />
          <span className="eval-header-link-name">
            {dataset?.name ?? "Dataset missing"}
          </span>
          {dataset && "↗"}
        </button>
      </div>
    </div>
  );

  const editor = (
    <div className="eval-editor">
      <section className="eval-section">
        <label className="eval-select-row">
          <span className="eval-select-label">
            <PromptLinkIcon />
            Prompt
          </span>
          <SelectBox label={prompt?.name ?? "(missing prompt)"}>
            <select
              className="pg-model-overlay-select"
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
          </SelectBox>
        </label>
        <label className="eval-select-row">
          <span className="eval-select-label">
            <SmallDatasetsIcon />
            Dataset
          </span>
          <SelectBox label={dataset?.name ?? "(missing dataset)"}>
            <select
              className="pg-model-overlay-select"
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
          </SelectBox>
        </label>
      </section>

      <section className="eval-section">
        <h4 className="pg-msg-header pg-role-label eval-section-title">
          Checks
        </h4>
        {def.checks.length === 0 && (
          <p className="eval-empty">
            Nothing judges a run yet. Add a check to say what a good answer is.
          </p>
        )}
        {def.checks.map(check => (
          <CheckEditor
            key={check.id}
            check={check}
            info={checkInfos.find(c => c.uri === check.uri)}
            onChangeCheck={patch => changeCheck(check.id, patch)}
            onRemove={() => removeCheck(check.id)}
          >
            {checkInfos
              .find(c => c.uri === check.uri)
              ?.parameters.map(param =>
                renderField(param, {
                  key: `check:${check.id}:${param.name}`,
                  label: param.name,
                  matchedKey: `check:${check.id}:${param.name}`,
                  selection: state.checks[check.id]?.[param.name] ?? {},
                  onChange: selection =>
                    changeCheckParam(check)(param.name, selection),
                  sources: checkSources[check.id] ?? EMPTY_SOURCES,
                  slots: checkSources[check.id]?.functionSlots ?? {},
                }),
              )}
          </CheckEditor>
        ))}
        <AddCheckMenu checks={checkInfos} onAdd={addCheck} />
      </section>

      <section className="eval-section">
        <h4 className="pg-msg-header pg-role-label eval-section-title">Runs</h4>
        {runs.length === 0 ? (
          <p className="eval-empty">No runs yet. Run it from the panel.</p>
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
            onDelete={handleDeleteRun}
          />
        )}
      </section>
    </div>
  );

  const panel = (
    <ExecPanelShell
      title="Inputs"
      notice={
        problems.length > 0 && (
          <ul className="eval-problems" aria-label="Problems">
            {problems.map(p => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )
      }
      footer={
        <RunButton
          choices={runChoices}
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
      }
    >
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
        <p className="eval-empty">Choose a prompt.</p>
      )}
      <div className="pg-exec-section" />
      {((prompt?.inputSources?.resources.length ?? 0) > 0 ||
        Object.keys(state.instances).length > 0) && (
        <ResourcesSection
          instances={state.instances}
          onChange={changeInstances}
          sources={sources}
          catalog={prompt?.inputSources?.resources ?? []}
          referencedBy={instance =>
            referencesTo(instance, state.instances, [
              { selections: state.fn },
              { selections: state.exec },
              ...Object.values(state.checks).map(selections => ({
                selections,
              })),
            ])
          }
          context={context}
        />
      )}
      <div className="pg-exec-section" />
      <RunOptions choices={runChoices} />
    </ExecPanelShell>
  );

  return (
    <div className="eval-view">
      <PromptSplit header={header} editor={editor} panel={panel} />
    </div>
  );
}

/**
 * One check in the editor: its label, a remove button, its parameter fields
 * (`children`), and a score threshold. Built-in checks only pass or fail, so
 * the threshold is offered for the others — those that may return a score.
 */
function CheckEditor({
  check,
  info,
  onChangeCheck,
  onRemove,
  children,
}: {
  check: EvalCheck;
  info: CheckInfo | undefined;
  onChangeCheck: (patch: Partial<EvalCheck>) => void;
  onRemove: () => void;
  /** The check's parameter fields. */
  children?: ReactNode;
}) {
  const label = check.label ?? info?.label ?? check.uri;
  const showThreshold =
    info?.group !== "Built-in" || check.threshold !== undefined;
  return (
    <div className="eval-check">
      <div className="eval-check-header">
        <span className="eval-check-label" title={check.uri}>
          {label}
        </span>
        {info?.group && <span className="eval-check-group">{info.group}</span>}
        <button
          type="button"
          className="pg-dismiss eval-check-remove"
          title="Remove check"
          aria-label={`Remove ${label}`}
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
      {(children || showThreshold) && (
        <div className="eval-check-fields">
          {children && <div className="eval-check-params">{children}</div>}
          {showThreshold && (
            <label
              className="eval-check-threshold"
              title="For a check that returns a score: pass at or above this. Left empty, the score is just recorded."
            >
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
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  })
                }
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A select drawn like the prompt editor's model picker: the chosen name in a
 * pill with a chevron, the native select laid invisibly over it.
 */
function SelectBox({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="eval-select">
      <span className="proppy-catalog-label">{label}</span>
      <span aria-hidden className="proppy-catalog-chevron">
        ▾
      </span>
      {children}
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
      <div className="pg-add-msg-btn pg-add-question">
        ＋ Add check
        <select
          aria-label="Add check"
          className="pg-model-overlay-select"
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
      </div>
      {broken.map(c => (
        <div className="pg-exec-error" key={c.uri}>
          <code>{c.uri}</code> failed to load: {c.error}
        </div>
      ))}
    </div>
  );
}

/** What the Run button runs against, as chosen in {@link RunOptions}. */
type RunChoices = ReturnType<typeof useRunChoices>;

/**
 * The choices behind Run: Working tree, plus Unsaved edits when the prompt has
 * some, and any named variation; how many run at once; and whether the tree
 * has uncommitted changes, or there's no git to pin results to.
 */
function useRunChoices(prompt: NormalizedPrompt | undefined) {
  const [variations, setVariations] = useState<VariationInfo[]>([]);
  const [head, setHead] = useState<{ versioned: boolean; clean: boolean }>();
  const [chosen, setChosen] = useState<Set<string>>(new Set(["head"]));
  const [concurrency, setConcurrency] = useState(4);
  const preselected = useRef<string | undefined>(undefined);

  const wip = variations.find(v => v.wip && v.onHead);
  const named = variations.filter(v => !v.wip && v.names.length > 0);

  // What there is to run against, read when the prompt is known and again as
  // its unsaved edits come and go (its `wipId`).
  const promptKey = prompt && `${prompt.providerId}:${prompt.id}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on the prompt and its unsaved edits; `prompt` itself changes identity on every edit.
  useEffect(() => {
    if (!prompt?.providerId) return;
    let cancelled = false;
    Promise.all([
      getPromptVariations(prompt).catch(() => []),
      getProviderHead(prompt.providerId).catch(() => undefined),
    ]).then(([vs, h]) => {
      if (cancelled) return;
      setVariations(vs);
      setHead(h);
      // Unsaved edits are pre-selected when there are some: the tight loop is
      // "edit, run the eval, compare". Once per set of edits, so unchecking
      // them sticks.
      const editing = vs.find(v => v.wip && v.onHead);
      if (editing && editing.id !== preselected.current) {
        preselected.current = editing.id;
        setChosen(prev => new Set([...prev, "wip"]));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [promptKey, prompt?.wipId]);

  const toggle = (key: string) =>
    setChosen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // With nothing else to run against there is no choice to make, so the
  // working tree runs even if it was unchecked before the others went away.
  const single = !wip && named.length === 0;
  const arms: EvalArmSpec[] = [
    ...(single || chosen.has("head") ? [{ kind: "head" } as const] : []),
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
  const warning =
    head && !head.versioned
      ? "⚠️ Results won't record a version."
      : head && !head.clean
        ? "⚠️ There are uncommitted changes."
        : undefined;

  return {
    wip,
    named,
    single,
    chosen,
    toggle,
    concurrency,
    setConcurrency,
    arms,
    warning,
  };
}

/**
 * What to run against — a checkbox for each choice under a "Run against"
 * heading, unless there is only one, then how many run at once — in the inputs
 * panel's scrolling body.
 */
function RunOptions({ choices }: { choices: RunChoices }) {
  const { wip, named, single, chosen, toggle, concurrency, setConcurrency } =
    choices;
  const headingId = useId();
  return (
    <div
      className="eval-run-options"
      role="group"
      aria-labelledby={single ? undefined : headingId}
    >
      {!single && (
        <>
          <span className="pg-exec-param-name" id={headingId}>
            Run against
          </span>
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
          <div className="pg-exec-section" />
        </>
      )}
      <label className="eval-run-concurrency">
        Parallel workers
        <input
          type="number"
          min={1}
          value={concurrency}
          onChange={e =>
            setConcurrency(Math.max(1, Number(e.target.value) || 1))
          }
        />
      </label>
    </div>
  );
}

/**
 * The Run button, running against what {@link RunOptions} has chosen, with the
 * warning above it when the tree has uncommitted changes or there's no git.
 */
function RunButton({
  choices,
  disabled,
  onRun,
}: {
  choices: RunChoices;
  /** Whether there are problems to fix first. */
  disabled: boolean;
  onRun: (options: {
    arms: EvalArmSpec[];
    concurrency: number;
  }) => Promise<void>;
}) {
  const { arms, concurrency, warning } = choices;
  const [busy, setBusy] = useState(false);
  return (
    <div className="eval-run-control">
      {warning && <p className="eval-run-warning">{warning}</p>}
      <button
        type="button"
        className="pg-run-btn"
        disabled={disabled || busy || arms.length === 0}
        title={
          disabled
            ? "Fix the problems below to run"
            : arms.length === 0
              ? "Choose what to run against"
              : undefined
        }
        onClick={async () => {
          setBusy(true);
          await onRun({ arms, concurrency });
          setBusy(false);
        }}
      >
        {busy ? "…" : "▶  Run"}
      </button>
    </div>
  );
}

/**
 * The eval's runs, newest first, with live progress for those in flight and a
 * button at the end of each row to delete it.
 */
function RunList({
  runs,
  progress,
  onOpen,
  onCancel,
  onDelete,
}: {
  runs: EvalRunSummary[];
  progress: Record<string, EvalRunProgress>;
  onOpen: (run: EvalRunSummary) => void;
  onCancel: (run: EvalRunSummary) => void;
  /** Resolves once the run is deleted, or deleting it failed or was declined. */
  onDelete: (run: EvalRunSummary) => Promise<void>;
}) {
  /** Runs being deleted, whose buttons wait — a run in flight is cancelled first. */
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const remove = async (run: EvalRunSummary) => {
    setDeleting(prev => new Set(prev).add(run.id));
    await onDelete(run);
    setDeleting(prev => {
      const next = new Set(prev);
      next.delete(run.id);
      return next;
    });
  };
  return (
    <div className="eval-runs-scroll">
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
                      <progress max={run.total} value={done} /> {done}/
                      {run.total}
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
                    <span className="eval-count-fail">
                      {counts.fail} failed
                    </span>
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
                <td className="eval-run-actions">
                  <button
                    type="button"
                    className="eval-run-delete"
                    title="Delete run"
                    aria-label={`Delete run from ${formatTimestampCompact(run.startedAt)}`}
                    disabled={deleting.has(run.id)}
                    onClick={e => {
                      e.stopPropagation();
                      void remove(run);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default EvalView;
