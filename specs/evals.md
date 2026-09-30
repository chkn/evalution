# Proposal: Offline evals

## Context

Evalution can run a prompt, trace it, and save its inputs as dataset rows (`specs/datasets.md`).
What it can't do is say whether a run was **right**. The motivating case is asgard's Odin
(`apps/api/src/agents/odin/odin.prompt.ts`), which plans a task by calling `list_tasks`,
`create_task`, `update_task` and `post_message` against the app database. "Did Odin create a child
task called *Set up CI*?" is the question worth asking, and it has two properties that shape
everything here:

- **It's about the world, not the transcript.** Asserting on tool calls is brittle. A model that
  creates the task with the wrong name and then renames it did the job, and a tool-call assertion
  fails it. The assertion that matters is a query against the database after the run.
- **It needs an expected value.** "Called *Set up CI*" is specific to one input. It belongs beside
  that input in the dataset row, not in code.

**The ask:** an eval is **a prompt + a dataset + a set of checks**. Evals can be saved, and they run
against the latest version of the prompt or against its variations
(`specs/prompt-versions-and-variations.md`).

Decided up front (2026-09-25):

- **Offline only.** Online evals, whether inside a running app or in the cloud over ingested
  production traces, are shelved. They need the world's state to be captured into the trace,
  because the world isn't there to query afterwards. Offline, it is. That's what the shelved
  `specs/resource-observation.md` was building toward, and none of it is needed here (§K).
- **An eval is data, not code.** It isn't versioned with the prompt: the point is to hold the eval
  still while the prompt varies. It lives in a gitignored DB under `.evalution/`, like datasets and
  traces.
- **Checks are code.** A check that queries the app database has to be code, and it's tied to the
  app's schema and helpers (`listTasksUnder`), which live in the repo. So checks are playground
  exports, referenced by URI the way resources are. The eval (data) names them. The checks (code)
  never name a dataset.
- **Expected values are dataset columns.** They're bound to typed check parameters. Datasets don't
  need an "expected" field role (`datasets.md` §K anticipated one), because a column is a column.
- **Arms are variations.** One eval run can run several prompt variants side by side: head, the WIP,
  and named variations, all on head (V&V decision: nothing runs against old code in v1).

Decided 2026-09-29:

- **Every prompt input is bound explicitly**, as in the execute panel. An earlier draft had the
  runner map a row's cells onto slots by name and type at run time, with eval-level `defaults` for
  whatever was left over. Instead, the eval stores one binding per slot, and the editor pre-fills
  them with the same matching heuristics (§F.1). What runs is exactly what the eval says, and the
  dataset no longer has to be shaped like the prompt.
- **Datasets get user-added primitive fields and value-cell editing** (`datasets.md` §P), which is
  how an `expectedTitle` column comes to exist.

---

## A. What an eval is

```ts
/** A saved eval: data, stored by an {@link EvalProvider}. */
interface EvalDefinition {
  id: string;
  name: string;
  /** The prompt under test. `globalId` when it has one, so moves and renames don't orphan it. */
  prompt: PromptID;                         // { id, providerId }
  dataset: { providerId: string; id: string };
  /**
   * One binding per prompt slot, in the shape the execute panel persists. A
   * binding may name a column (`dataset`), another slot (`input`), a resource
   * with arguments, a typed-in value, or an object mixing those (§B.2).
   */
  inputs: {
    functionInputs: Record<string /* param name */, ExecutionInput>;
    executeInputs: Record<string, ExecutionInput>;
  };
  checks: EvalCheck[];
  createdAt: number;
  updatedAt: number;
}

/** One check, as an eval uses it. */
interface EvalCheck {
  /** Stable within the eval; results are keyed by it. */
  id: string;
  /** The check's URI: `<module>#<export>`, or a built-in (§C.3). */
  uri: string;
  /** Overrides the check's own label in this eval. */
  label?: string;
  /** Values for the check's schema-valued inputs, by name (§B.2). */
  args: Record<string, ExecutionInput>;
  /** For a check that returns a score: at or above this passes. Absent: report the score only. */
  threshold?: number;
}
```

A prompt, a dataset, and bindings. Bindings are keyed by slot name and are checked against the
prompt's **current** signature. The editor flags them as soon as the prompt changes (§F.1), and a
run refuses to start while any required slot is unbound or any binding names a slot, column, or
check parameter that no longer exists. It lists what's wrong rather than failing row by row. All
arms share one signature, because a variation can't change parameters (`NormalizedPromptUpdates`
has no field for them), so one check covers the whole run. Values are still validated where
they're resolved (§B.2).

For Odin, with a dataset of plain data:

| | |
| --- | --- |
| prompt | `apps/api/src/agents/odin/odin.prompt.ts#orchestrate` |
| dataset | "Odin planning": `title`, `description`, `expectedTitle` (`string`), and `threadMsgs` (type copied from the prompt's parameter) |
| `taskId` | `seededTask.taskId` with `title` ← column `title`, `description` ← column `description` |
| `taskInfo` | `{ title` ← column `title`, `description` ← column `description }` |
| `threadMsgs` | column `threadMsgs` |
| `roster` | `odin.playground.ts#roster` |
| `toolsContext.*` | `db` ← `db.db`, `workspaceId` ← `db.workspaceId`, `runId` ← `seededRun.agentRunId`, `rootTaskId` ← input `taskId` |
| checks | `checks.ts#createsTask` with `rootTaskId` ← input `taskId` and `title` ← column `expectedTitle`; `evalution/checks#toolCalled` with `name` ← `"success"` |

This is the layering `resource-arguments.md` §A described, `dataset row → resource args →
prompt slots`, where the eval supplies the middle step. The rows hold only data. They could have
been typed in by hand (`datasets.md` §P) or lifted from production traces as values
(`datasets.md` §D.3). A dataset captured from the playground, whose cells already hold
`seededTask` refs, works too: binding `taskId` ← column `taskId` resolves the ref in the cell.

`threadMsgs` is a whole-array column: each cell is a `value` holding the full array. That's how a
thread varies per row, since an array literal can't hold a column binding (only objects nest in
`ExecutionInput`). The column's type is copied from the prompt's parameter (`datasets.md` §P.1),
so each cell is edited with the same editor the panel uses.

## B. Checks are playground exports

```ts
// .evalution/playground/checks.ts
import { check } from "evalution";
import { expect } from "vitest";          // or node:assert, or chai — anything that throws AssertionError
import { db } from "./db.ts";

export const createsTask = check({
  group: "Odin",
  label: "Creates a task with the expected title",
  inputs: {
    db,                                     // bound in code: the same instance the run's tools used
    rootTaskId: z.string().refine(isTaskId), // bound by the eval: a column, a literal, or a resource
    title: z.string(),
  },
  run: async ({ db: { db, workspaceId }, rootTaskId, title }, run) => {
    const tasks = await listTasksUnder(db, workspaceId, rootTaskId);
    expect(tasks.map(t => t.title)).toContain(title);
  },
});
```

### B.1 The definition

```ts
export interface CheckDefinition<N extends ResourceInputs> {
  label?: string;
  group?: string;
  description?: string;
  /** Exactly a resource's `inputs`: resources bound in code, schemas bound by the eval. */
  inputs?: N;
  run(inputs: ResolvedResourceInputs<N>, run: CheckRun): CheckOutcome | Promise<CheckOutcome>;
  /** Default 30s. A check that exceeds it is an `error`. */
  timeoutMs?: number;
}

/** What the check is judging. */
export interface CheckRun {
  /** The run's trace, complete (§D.3). */
  trace: TraceWithSpans;
  /** The dataset row, cells unresolved. */
  row: DatasetRow;
  status: "ok" | "error";
  error?: string;
}

export type CheckOutcome =
  | void | boolean | number
  | { pass?: boolean; score?: number; message?: string; details?: unknown };
```

`inputs` is **the same map a resource declares**, for the same reasons `resource-arguments.md` §B
gave: one namespace, resources and schemas told apart at run time by tag, and validation for free.
The loader, the checker probe that turns schema entries into `PropDefinition`s, and the lease that
resolves them are the ones resources already use. A check is a resource whose `create` is called
once, after the run, and returns a verdict instead of a value.

**Resource inputs resolve from the run's own lease.** `db` above is the `db` resource object, so
the lease's memo (keyed by resource and argument key, `resource-arguments.md` §D) returns the
Miniflare instance the tools just wrote to. The check doesn't have to be told which database. It
names the same resource the prompt's bindings do.

### B.2 Binding: two new `ExecutionInput` variants

Prompt slots and check inputs are bound with the same union the panel and dataset cells use, plus
two new variants:

```ts
/** A cell of the dataset row being run. Only meaningful in an eval run. */
| { kind: "dataset"; field: string /* DatasetField.id */ }
/** Whatever the same run bound to one of the prompt's own slots. Works anywhere a run is assembled. */
| { kind: "input"; half: "function" | "execute"; path: string /* "taskId", "toolsContext.list_tasks.db" */ }
```

`dataset` needs a row, so outside an eval run it fails with a message that says so, and the panel
never offers it. `input` needs only the other slots of the same run, so it works in the execute
panel too (§B.2.1).

**`dataset`.** `ExecutionInput` has declared `{ kind: "dataset"; uri }` since `execution-inputs.md`,
unimplemented, with `datasets.md` §A leaving it for "running a prompt over a dataset". This is that.
It becomes `field`, because within an eval run the row is implicit and the field id is all that's
needed. It's allowed anywhere a binding is, including inside a resource's `args` and an `object`'s
properties. That's how `seededTask`'s `title` comes from a column. A cell may itself hold a
resource ref or an object, and resolves recursively.

**`input`.** A check usually needs a value the prompt was given: the task Odin planned, the
database it wrote to. When that slot is bound directly to a column, binding the check to the same
column would work. But `taskId` above is bound to `seededTask` over two columns, and the check
would have to repeat that recipe exactly. If it drifted, the check would quietly look at a
different task. `input` names the slot instead:

- **It resolves the slot's binding in the run's lease**, so a resource comes back as the same
  instance through the memo, keyed on the same recipe. The check gets the id the run was given,
  and the task is created once.
- **Prompt slots can use it too.** `toolsContext.*.rootTaskId` ← input `taskId` states that the
  two are the same id rather than hoping two recipes agree.
- **Cycles are rejected** when the eval is saved and again at run start (`a` ← input `b` ← input
  `a`), naming the slots, as `resource-arguments.md` §D does for argument cycles.
- **`path` is the dotted slot path** `PromptInputSources` already uses, and `half` keeps a function
  parameter apart from an execute parameter that happens to share its name.

#### B.2.1 `input` in the execute panel

The panel's request is itself a complete set of bindings, so `resolveExecutionInputs` takes the
request's own `functionInputs`/`executeInputs` as its `bindings` context, and `input` resolves the
same way it does in an eval. In Odin's playground, `toolsContext.*.rootTaskId` ← input `taskId`
means picking a different seeded task changes both at once, instead of two chips that have to be
kept in step by hand.

- **The `SourcePicker` gains a Prompt inputs group** in the panel as well as the eval editor. It
  lists the other slots whose type fits, and never offers the slot itself or any slot that would
  close a cycle. A slot bound this way shows a "= `taskId`" chip.
- **It's recorded as-is.** A trace stores the `input` recipe, not the value it produced. A replay
  sends the whole recipe set back, so it resolves identically. A dataset row captured from the
  panel keeps it too, and it means the same thing wherever the row is used, because slot paths are
  the prompt's own.
- **The server validates it** with everything else in the request: a target slot that doesn't exist
  or a cycle is a 400 naming the slots, before anything is created.
- **It's explicit where combined mode is implicit.** `combined-execute-inputs.md` merges slots with
  the same name *and* type into one editor. `input` links any two slots whose types fit, such as
  `rootTaskId` and `taskId`, and says so in the recipe. The two coexist, and nothing here changes
  combined mode.

This is useful without evals and can ship first (§I).

**Types are checked twice, loosely then strictly.**

- *When editing:* dataset fields carry `PropDefinition`s (`datasets.md` §B), and prompt slots and
  check inputs have theirs from the probe. Pre-filling (§F.1) uses them. For explicit choices the
  picker offers every column and every prompt slot, and marks a type mismatch as a warning rather
  than refusing it: `string` vs a branded `TaskId` is a mismatch the schema will accept.
- *When running:* each resolved value passes through the input's schema before `run` sees it
  (`resource-arguments.md` §B). A row whose cell fails validation is an `error` for that check,
  naming the input and the issue. It is never a `fail`, because the prompt did nothing wrong.

This is the answer to "datasets aren't strongly typed". The code declares types, the data is
bound to them per eval, and the boundary validates.

### B.3 Outcomes

| check does | outcome |
| --- | --- |
| returns `undefined` or `true` | `pass` |
| returns `false` | `fail` |
| returns a number | a score; `pass`/`fail` only if the eval set a `threshold` |
| returns an object | its fields, as given |
| throws an error named `AssertionError` | `fail`, with the message (and `expected`/`actual` in `details` when present) |
| throws anything else, times out, or an input fails validation | `error` |
| the prompt run itself errored | `skipped`, unless the check declares `runsOnError: true` |

Treating `AssertionError` by name covers `node:assert`, chai, and Vitest's standalone `expect`
without depending on any of them. A check that throws a `TypeError` is broken, not failing, and
the two are reported differently because they call for different fixes.

Checks are **read-only by contract**, so a row's checks run concurrently.

### B.4 Registry and wire

`check()` tags its result with `CHECK_TAG` (a sibling of `RESOURCE_TAG`), and `isCheck` recognizes
it. The playground module loader already walks every export of every playground file. It collects
checks beside resources, under the same URI grammar and the same `group`/`label` display rules.

```ts
/** What the client knows about a check. */
interface CheckInfo {
  uri: string;
  label: string;
  group?: string;
  description?: string;
  /** The schema-valued inputs, as the probe resolved them. Resource inputs are not listed. */
  parameters: PropDefinition[];
  /** Set when the module failed to load or the definition is invalid. */
  error?: string;
}
```

`PromptProvider` gains `listChecks?(): Promise<CheckInfo[]>`, which `FilePromptProvider`
implements from the registry. Checks are provider-scoped because resources are: a check's
resource inputs have to come from the lease of the provider running the prompt.

### B.5 Built-in checks

`evalution/checks` ships a small set under the same mechanism, with URIs `evalution/checks#<name>`:

| check | inputs | passes when |
| --- | --- | --- |
| `outputContains` | `text`, `caseSensitive?` | the final assistant text contains `text` |
| `outputEquals` | `expected` | the final output deep-equals `expected` (text or JSON) |
| `toolCalled` | `name`, `times?` | a `TOOL` span named `name` exists (exactly `times` of them, if given) |
| `maxCost` | `usd` | the trace's total cost ≤ `usd` |
| `maxDuration` | `ms` | the root span's duration ≤ `ms` |

They read the trace through helpers exported alongside them (`finalText(trace)`,
`toolCalls(trace)`), which user checks can import too. `toolCalled` exists for the invariants
where the call itself is the point: "it called `success`", not "it created the task".

## C. Arms

An eval run executes every row once per **arm**. An arm is a prompt ref from
`specs/prompt-versions-and-variations.md` §B:

| arm | ref | what runs |
| --- | --- | --- |
| Working tree | `{ promptId }` | head |
| Unsaved edits | `{ variation: wipId }` | the WIP, frozen at run start |
| a named variation | `{ variation: id }` | that variation, rebased onto head |

**Every arm runs on head's code.** A named variation made against an older version is rebased when
the run starts (V&V §H). A clean rebase is silent. A conflicted one fails that arm before any row
runs, listing the conflicts, and the other arms proceed. This is the "test variations against the
latest eval" guarantee: checks, dataset, tools, and resources are always current, and only the
prompt fields the variation sets differ.

**The version is recorded at start, when there is one.** The run calls `versions.head()` when it
begins, and each row records the `{ version, variation }` its `execute` returned. A version is a
commit, and only a run on a clean working tree has one (V&V §C). Uncommitted changes are never
captured, so:

- **Clean tree:** the run records the commit as `start_version`. Its results can be traced back to
  exactly what ran.
- **Dirty tree:** the run still starts, but the run dialog warns first ("You have uncommitted
  changes. Results won't be reproducible; commit first to pin them to a version"). The run is
  stored with `dirty` set and no `start_version`, and badged *uncommitted changes* wherever it's
  listed. Its rows record no version, but still record their variations.

If the working tree changes mid-run, a row's version differs from the start version (or a clean
start is followed by rows that recorded none), and the run is badged *drifted*. A worktree could
prevent this, and v1 doesn't have one (V&V §J). Reporting drift is honest and cheap.

Without a versioning-capable provider (no git), results record no version, and the dialog says so
once, like the dirty-tree warning.

## D. Running

### D.1 One run of one row

For each (arm, row):

1. **Inputs.** The eval's `inputs`, unchanged, with the row as resolution context. There's no
   per-row mapping: the bindings were checked against the signature when the run started (§A). A
   `dataset` binding to a cell this row leaves empty resolves to nothing. If the slot is required,
   the row is an `error` ("row 7 has no `title`") and no run happens.
2. **Resolve and execute** through the same path as the execute route. Its body moves out of
   `api-routes.ts` into `runPrompt(provider, ref, inputs, options)` in `src/server/run-prompt.ts`,
   so the route and the runner share one implementation: receipts stamped, trace id minted, and
   `onSettled` wired.
3. **Wait for the trace** (§D.3).
4. **Checks.** Resolve each check's inputs **in the run's lease**, then run them concurrently.
5. **Release** the lease. Resettable resources unlock for the next row.

Step 4 has to happen before step 5. That's why checks can't be an after-the-fact pass over stored
traces: once the lease is released, `reset` clears the rows the check needs to see.

Two additions to `ResolvedPromptInputs` make that ordering possible:

```ts
interface ResolvedPromptInputs {
  // … functionParams, executeValues, receipts, release
  /**
   * Resolves more inputs within this run's lease, before {@link release}: a
   * check's inputs, so its resources are the run's own instances.
   */
  resolveMore?(inputs: Record<string, ExecutionInput>): Promise<Record<string, unknown>>;
}
```

and `resolveExecutionInputs` takes an optional context `{ row?: DatasetRow; bindings?:
EvalDefinition["inputs"] }`. The `dataset` variant reads the row, and the `input` variant looks
up the slot's binding and resolves that in its place. Outside an eval there's no context, and both
fail with a message that says so.

### D.2 Scheduling

Arms × rows go into one queue with a concurrency limit (default 4, set per run). Nothing extra is
needed for correctness. Asgard's `db` declares `reset`, so its lease lock (`resource-arguments.md`
§F) already serializes the runs that share it, and the queue simply waits. An eval over a prompt
with no resettable resources runs in parallel.

A run can be cancelled. Queued rows become `skipped`, and in-flight rows finish (the SDKs have no
abort path yet) and are recorded.

### D.3 The trace has to be complete

`onSettled` fires when the SDK call completes. On the OTel path, spans may still be sitting in a
batch processor. The runner polls the default trace provider until the trace's root span has ended
(every 100ms, up to 10s). If the timeout hits, the checks still run on whatever arrived, and the
result is flagged `traceIncomplete`. Trace-based built-ins then report `error` rather than guess.
Database checks don't care.

### D.4 Where it runs

`EvalRunner` (`src/eval/eval-runner.ts`) is server-side and owned by the server like the prompt
registry. Progress goes out on the existing `/api/events` stream as `eval-run` events
(`{ runId, done, total, counts }`), so the run view updates live without a new SSE route.

## E. Storage: `EvalProvider`

```ts
export interface EvalProvider {
  readonly id: string;
  readonly displayName?: string;

  listEvals(): Promise<EvalSummary[]>;
  getEval(id: string): Promise<EvalDefinition | undefined>;
  createEval(input: Omit<EvalDefinition, "id" | "createdAt" | "updatedAt">): Promise<EvalDefinition>;
  updateEval(id: string, patch: Partial<Omit<EvalDefinition, "id">>): Promise<EvalDefinition>;
  deleteEval(id: string): Promise<void>;

  createRun(evalId: string, run: NewEvalRun): Promise<EvalRun>;
  finishRun(runId: string, status: EvalRunStatus): Promise<void>;
  listRuns(evalId: string): Promise<EvalRunSummary[]>;
  getRun(runId: string): Promise<EvalRun | undefined>;

  recordRowResult(result: EvalRowResult): Promise<void>;
  recordCheckResults(results: EvalCheckResult[]): Promise<void>;
  listResults(runId: string): Promise<{ rows: EvalRowResult[]; checks: EvalCheckResult[] }>;
  /** Check results for one trace, so the trace view can show them (§F). */
  resultsForTrace(traceProviderId: string, traceId: string): Promise<EvalCheckResult[]>;

  watch?(callback: (event: EvalChangeEvent) => void): () => void;
}
```

`TursoEvalProvider` keeps everything in one database, `.evalution/evals/evals.db`, a self-ignoring
directory. It's one file rather than one per eval (unlike datasets): results are the bulk, they're
queried across evals by trace id, and an eval's definition is a few hundred bytes.

```
evals              id PK, name, prompt JSON, dataset_provider_id, dataset_id,
                   inputs JSON, checks JSON, created_at, updated_at
eval_runs          id PK, eval_id → evals ON DELETE CASCADE,
                   definition JSON,           -- the eval as it was when the run started
                   arms JSON,                 -- [{ id, label, ref, rebasedTo?, error? }]
                   start_version, dirty, status, drifted, concurrency, started_at, ended_at
eval_row_results   run_id → eval_runs ON DELETE CASCADE, arm_id, row_id, sample,
                   row_cells JSON,            -- the row as run
                   trace_provider_id, trace_id, version, variation,
                   status, error, cost_usd, duration_ms, trace_incomplete
                   PK (run_id, arm_id, row_id, sample)
eval_check_results run_id, arm_id, row_id, sample, check_id,
                   outcome, score, message, details JSON, duration_ms
                   PK (run_id, arm_id, row_id, sample, check_id)
                   INDEX on eval_row_results (trace_provider_id, trace_id)
```

- **A run stores the definition it ran.** Evals are editable. A run from last week has to keep
  meaning what it measured, including checks that have since been removed or rebound.
- **A result stores its row's cells.** Datasets allow deleting rows. A result has to stay readable
  without the row, and the row's cells are small.
- **Cost and duration are copied from the trace** when the row finishes. The summary view
  aggregates hundreds of rows, and opening hundreds of traces for that would be slow. Traces can
  also be deleted.
- **`sample` is in the key from day one** and always `0` in v1. Running each row *n* times, to
  measure a nondeterministic prompt's pass rate rather than one draw of it, is the most likely next
  feature (§L.2), and adding a key column to a populated table is a migration nobody wants.

## F. UI

- **Sidebar: Evals**, below Datasets. Each entry shows the last run's overall pass rate.
- **New eval:** from a dataset ("New eval…" pre-fills the dataset and its linked prompt), from the
  prompt toolbar, or from the sidebar.
- **Eval editor:**
  - A header with name, prompt, and dataset pickers.
  - **Inputs:** the execute panel itself (`CombinedInputEditor` over every slot, with the same
    layout rules), so binding an eval looks exactly like setting up a run. The `SourcePicker`
    gains two groups here: **Columns** (the dataset's fields) and **Prompt inputs** (the other
    slots, for `input` bindings). Resource arguments get the same picker, so `seededTask`'s
    `title` can take a column.
  - **Checks:** "＋ Add check" opens a picker grouped like the resource picker (built-ins first,
    then playground groups). Each check lists its parameters with `ExecutionInputEditor` and the
    same picker. An optional threshold field appears for scoring checks.
  - **Problems** are listed above Run: unbound required slots, bindings to slots or columns that
    no longer exist, and `input` cycles. Run stays disabled until the list is empty. Saving never
    is: a half-bound eval is a legitimate draft.
- **Run:** a button with an arms selector, which pre-selects Working tree, plus Unsaved edits when a
  WIP exists. Also available from the prompt toolbar as "Run eval ▸", for the tight loop: edit,
  run the eval, compare.
- **Run view:**
  - A summary strip per arm: pass rate per check, mean score, errors, total cost, and p50/p95
    duration.
  - Below it, a virtualized grid (the dataset grid's machinery): rows × (arm × check), with cells
    coloured by outcome.
  - Clicking a cell opens the row's trace in the side pane with the check messages above it.
  - Arms sit side by side, so "variation B fixes rows 3 and 7 and breaks row 12" is visible
    without a separate diff.
- **Compare runs:** pick another run of the same eval. Rows whose outcome changed are listed first,
  pass→fail in red.
- **Trace view:** a trace that belongs to an eval result gets a **Checks** section in the details
  pane (`resultsForTrace`). Results aren't written as annotations. Annotations are human judgment
  and are editable. Check results are machine output tied to a run. Mixing them makes both harder
  to trust.

**Wire.** `GET /api/eval-providers`, `GET|POST /api/evals`, `GET|PATCH|DELETE /api/evals/:p/:id`,
`POST /api/evals/:p/:id/runs` (body: `{ arms, concurrency }`), `GET /api/evals/:p/:id/runs`,
`GET /api/eval-runs/:p/:runId` (results included), `POST /api/eval-runs/:p/:runId/cancel`,
`GET /api/checks` (all providers' `CheckInfo`), and
`GET /api/traces/:p/:id/check-results`.

### F.1 Pre-filling bindings

Binding everything by hand would be tedious for the common case, a dataset made from this prompt,
so the editor proposes bindings. It never overwrites one the user set. For each unbound leaf slot
(object slots are filled property by property, as the panel does), it tries these in order:

1. **A matching column.** A dataset field that matches the slot by `datasets.md` §B's rule (name
   and `type.syntax` equal) → `{ kind: "dataset", field }`. A dataset created from the prompt
   binds completely at this step.
2. **What the playground last ran.** The panel's persisted selection for this prompt
   (`paramStorageKey`), with resource chips and their arguments included. That's how `db`, `roster`
   and `seededRun` usually arrive, since they're what the user already picked to run the prompt by
   hand.

Check parameters use step 1, then **a prompt slot with the same name and type** →
`{ kind: "input" }`. A check that declares `taskId: TaskId` binds itself to the prompt's `taskId`.

Anything still unbound stays empty. The editor deliberately doesn't guess "the only resource that
fits". A `string` slot would take whichever string-valued resource happened to be in scope, and a
confident wrong binding is worse than an obvious empty one.

When no column fits, the picker offers **"＋ New column from this slot"** (or from this check
parameter). It adds a field to the dataset with the slot's own `PropDefinition` (`datasets.md`
§P.1) and binds to it. That's how `expectedTitle` and `threadMsgs` would normally come to exist:
from the eval editor, with the types already right.

Pre-filling runs when the eval is created, and again for newly unbound slots whenever the prompt,
the dataset, or a check changes. It's pure (`src/client/components/eval-bindings.ts`), takes the
prompt, the dataset, the checks, and the stored panel state, and is unit-tested on its own.
Pre-filled bindings show a subtle "matched" mark until they're touched, so it's clear which choices
were made for the user.

## G. Configuration

`EvalutionConfig.evalProviders?: EvalProvider[]`. When it's omitted, `src/cli/index.ts` builds a
`TursoEvalProvider` on `.evalution/evals/`, the same way it defaults datasets. The runner takes the
first prompt provider matching the eval's `prompt.providerId`, the dataset provider matching
`dataset.providerId`, and the default trace provider.

## H. Non-goals

- **Online evals**, in the app or in the cloud. Shelved (§K).
- **LLM-judge checks.** They'd fit the mechanism: a built-in that runs an `experimental_evaluate`
  prompt with bindings and maps its answers to scores. But judge calibration is its own design
  (§L.3).
- **Running old versions.** V&V §J.
- **A CLI or CI runner.** See §L.1: evals are gitignored data, which CI can't see.

## I. Phasing

1. **Plumbing.**
   - Implement the `dataset` and `input` `ExecutionInput` variants (resolved against a row and the
     run's bindings), including cycle detection.
   - Extract `runPrompt` and add `resolveMore`.
2. **Checks.** `check()`, `CHECK_TAG`, registry collection, `CheckInfo` with probed parameters,
   `listChecks`, and the built-ins with their trace helpers.
3. **Storage.** `EvalProvider`, `TursoEvalProvider`, its migrations, and config defaulting.
4. **Runner.** Head-only arm, per-row pipeline, trace wait, scheduling, cancel, progress events.
5. **UI.** Evals list, editor (with §F.1's pre-filling and the problems list), run view, and the
   trace Checks section.
6. **Arms.** Variations as arms, rebase at start, drift detection, and run comparison. Needs V&V
   step 3.

`input` in the execute panel (§B.2.1) and `datasets.md` §P (user-added fields and cell editing)
are both independent and can land first. The
Odin example needs it for `expectedTitle` and its hand-typed rows.

Steps 1–5 are a complete, useful feature against head. Step 6 is the one that makes evals the way
to compare prompts.

## J. Files

- `src/shared/types.ts`: `ExecutionInput`'s `dataset` variant becomes `{ kind: "dataset"; field }`,
  the `input` variant is added, and so is `CheckInfo`.
- `src/prompt/execution-inputs.ts`: the eval context, `dataset` and `input` resolution, and cycle
  detection.
- `src/prompt/playground/check.ts`: `check()`, `CheckDefinition`, `CheckRun`, `CheckOutcome`,
  `CHECK_TAG`, and `isCheck`.
- `src/prompt/playground/resource-registry.ts`: collects checks, resolves their inputs through a
  lease, and exposes `resolveMore`.
- `src/checks/index.ts`: the built-ins and trace helpers, exported as `evalution/checks`
  (`package.json` `exports`).
- `src/prompt/prompt-provider.ts`: `listChecks?` and `ResolvedPromptInputs.resolveMore`.
- `src/server/run-prompt.ts`: extracted from the execute route.
- `src/eval/`: `eval-types.ts`, `eval-provider.ts`, `turso-eval-provider.ts`, `db/schema.ts`,
  `db/migrations/`, `eval-runner.ts`, and `outcomes.ts` (§B.3's table as a pure function).
- `src/server/api-routes.ts`: the routes in §F.
- `src/cli/index.ts`: default `TursoEvalProvider` and the runner's wiring.
- `src/client/components/eval-bindings.ts`: §F.1's pre-filling and the problems list (pure).
- `src/client/components/SourcePicker.tsx` and `ExecutionInputEditor.tsx`: the **Prompt inputs**
  group and the "= slot" chip, in the panel as well as the eval editor. `api-routes.ts` validates
  `input` targets and cycles on `/execute`.
- `src/client/`: `EvalList`, `EvalEditor` (reusing `CombinedInputEditor`), `EvalRunView`, the
  **Columns** and **Prompt inputs** groups in `SourcePicker`, and a Checks section in
  `DetailsPane`.
- `specs/resource-observation.md`: its status notes that offline evals don't need it (§K).

## K. What happens to `resource-observation.md`

It was shelved already. This spec removes its main motivation for now. §F there, "a scorer's input
must include the run's resource timelines", assumed the scorer would run after the world was gone.
Offline, the check runs inside the run's lease, against the live resources, so it can query
whatever it needs, and nothing has to be snapshotted to make that possible.

What survives, for when online evals come back: the observation that production has no resources,
so any state capture for online evals has to be app code shipped with the app, not a
`ResourceInstance` hook. That's a correction to that spec's §A, and it's recorded here so it isn't
rediscovered.

## L. Open questions

1. *CI.* Evals are gitignored data, and checks are code. A CI job can see the checks but not the
   eval or its dataset. Options: an export of an eval plus its dataset to a committed file, cloud
   sync (`evalution-cloud/PLAN.md` §3.3), or a CLI that takes a dataset file path. Decide when
   someone asks for it in CI.
2. *Samples per row.* Nondeterministic prompts want each row run *n* times and reported as a rate.
   The schema reserves `sample`, but the UI and aggregation are undecided (pass@k? mean? both?).
3. *LLM judges.* A built-in `judge` check that takes an `experimental_evaluate` prompt ref, binds
   its inputs like any check, and maps a `boolean` answer to pass/fail and a `score` answer to a
   score. Needs a design for calibrating the judge itself: a dataset of judged examples is itself
   an eval.
4. *Check timeouts vs. reset locks.* A slow check holds the row's lease, and therefore the reset
   lock, and therefore every queued row. The 30s default bounds it, but it may want to be lower
   for checks that declare database inputs.
