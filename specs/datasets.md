# Proposal: Datasets

## Context

`specs/execution-inputs.md` §C drew the line: authored data is a **dataset row**, not code, and it
lives in a Turso DB behind a `DatasetProvider`. `specs/resource-arguments.md` then built the door
between the two — a resource's arguments are `ExecutionInput`s, so a row can reach past the
serializable boundary by naming a resource and the data it should be created from. Both specs end
with "datasets plug in here". This is that plug.

**The ask:**

1. A `DatasetProvider` interface, with a Turso implementation that keeps **one DB file per dataset**
   under `.evalution/datasets/`, following the trace DB's patterns.
2. A **Datasets** section in the sidebar, below Traces, listing them; opening one shows its rows.
3. **Add to dataset** from the playground's execute panel — an existing dataset (matching fields
   only) or a new one (schema = the prompt's inputs, linked back to the prompt).
4. The same from a **trace**, using the recorded inputs so resource references survive.
5. For a dataset linked to a prompt, **open a row in the playground** with the execute panel filled.
6. While there: **"Open prompt" on a trace fills the execute panel** from that trace's inputs.

Decided up front (2026-09-21):

- Dataset files are **gitignored**, like traces. Sharing is the cloud-sync story
  (`evalution-cloud/PLAN.md` §3.3), not git.
- **One file per dataset**, as asked — with a schema that still carries `dataset_id`, so a cloud
  provider can hold every dataset in one project DB using the same schema verbatim (§E).
- **Production traces can be added too**, values only (§D.3).
- The dataset view in v1 is **view, delete, open** — no in-table cell editing (§J).

### A finding that changes step 1

Inputs *are* flowing into traces for playground runs — `FilePromptProvider.execute` records
`functionInputs`, `executeInputs` (with receipts stamped by `stampReceipts`) and
`parameterDefinitions` on the root span, and they reach the DB intact. But **the client never sees
them**: `resolveSpanPrompt` (`src/server/api-routes.ts:111`) rebuilds `span.prompt` as
`{ id, providerId }` and drops every other field, on both `GET /api/traces/:p/:id` and the SSE
stream. That one-line fix is the "make sure inputs flow" item. There's a second, smaller gap:
`parameterSnapshot` records only the *function* parameters, so a trace has no types for its
`executeInputs` (§H).

---

## A. A row is a set of named `ExecutionInput`s

This is the decision everything else follows from.

```ts
/** One dataset row: a cell per field it has a value for, keyed by field id. */
interface DatasetRow {
  id: string;
  cells: Record<string /* field id */, ExecutionInput>;
  /** Where the row came from — so the view can link back to the trace. */
  source?: DatasetRowSource;
  createdAt: number;
}

type DatasetRowSource =
  | { kind: "playground"; promptId: string; providerId: string }
  | { kind: "trace"; traceId: string; traceProviderId: string };
```

A cell is **not** a raw JSON value. It is the same `ExecutionInput` the panel already persists to
`localStorage`, sends to `/execute`, and records on a trace:

| cell | meaning |
| --- | --- |
| `{ kind: "value", value: PropValue }` | a typed-in value — a template stays a template |
| `{ kind: "object", properties }` | an object with some fields typed in and some filled by resources |
| `{ kind: "resource", uri, args? }` | "create this resource, from these arguments" — the non-serializable case |

Why this is the right shape rather than "JSON cells, plus a resource column type":

- **"Resource references for non-serializable types" costs nothing new.** It's the `resource`
  variant. A `Db` field holds `{ kind: "resource", uri: ".evalution/playground/db.ts#db" }`; a
  `taskId` field can hold `seededTask` *with its arguments*. That is exactly the
  `dataset row → seededTask(args) → prompt slot` path `resource-arguments.md` §A and §K laid out.
- **All three movements are identity transforms.** Panel → row is what `buildRequest` already
  builds. Trace → row is what the root span already records. Row → panel is `fromExecutionInput`,
  which already restores a stored selection. No new serialization and no new resolver.
- **It stays JSON-safe by construction**, which is what `execution-inputs.md` §F built the union
  for, so a row survives SQLite and, later, sync.

Two rules on the way in:

- **Receipts are stripped.** A receipt makes `create` reconstruct a *past run's* identity
  (`resource-arguments.md` §E: "only a replay sends one"). A dataset row is a recipe for new runs,
  not a replay of one. If two rows from two traces both kept `tsk_abc123`, running the dataset
  would collide on the id. Stripped client-side and again by the server, since a receipt in a row
  would do real harm. See §O.3.
- **The `dataset` variant of `ExecutionInput` is not used here.** Opening a row *copies* its cells
  into the panel. A `{ kind: "dataset", uri }` reference ("bind this slot to row N") is what running
  a prompt over a dataset needs, and it keeps its "declared, not implemented" status until then
  (§K).

## B. Schema: fields are `PropDefinition`s

```ts
interface DatasetField {
  /**
   * Stable, short id — row cells are keyed by it, so renaming a field never
   * rewrites rows. Base-36 of a per-dataset counter (`0`–`9`, `a`–`z`, `10`, …),
   * minted by the provider and never reused.
   */
  id: string;
  /** Name, type, description — the checker's view of the slot this field came from. */
  def: PropDefinition;
}
```

**Field ids are short because they repeat in every row.** The key is written into every cell of
every row, so a field name or a UUID would cost its full length × row count. A dataset has a
handful of fields, so a counter gives one-character keys for the first 36 and two for the next
1,260. The id is internal: nothing shows it, and it doesn't need to be unique outside its
dataset, since cells are only ever read against their own dataset's `fields`. The counter's
high-water mark is stored on the dataset (`nextFieldId`), so an id is never reused even if field
removal arrives later — a reused id would reinterpret old cells as the new field.

"Any TypeScript type" means **whatever the checker printed** for the slot the field was copied
from: `def.type.syntax` is the type and `def.type` is the structure the panel edits against.
That's the same `PropDefinition` the panel renders and `parameterDefinitions` already records, so
a field renders with `ItemEditor` with no translation step.

**Pushback: in v1, schemas are always derived, never typed in.** A field is created by copying a
prompt parameter (§G) or a trace's recorded definition (§H). A free-form "add a field of type
`Pick<Task, 'title'>`" editor has nothing to resolve that string against: the dataset belongs to no
file, so there is no program or checker for it. It would produce a `PropDefinition` with an
unresolved type that can't be edited and can't match anything. Wait until someone needs it; the
fix then is to resolve the type in a chosen prompt's program.

**Matching rule — the only one in this spec:**

> A source input and a dataset field match when their `name` is equal **and** their
> `type.syntax` is equal.

That's the exact merge key `combined-execute-inputs.md` §A chose, for the same reasons: it's plain
string comparison over data the client already has, it needs no checker, and it fails closed.
One consequence: a function parameter and an execute parameter with the same name *and* type are
one field, which is correct because they're one value. With the same name but different types,
they're two fields. Fields are unique by `(name, type.syntax)`, not by name.

Every field is optional within a row. "Only matching fields are filled" means rows are sparse by
design, and a missing cell renders as empty.

## C. Metadata and the prompt link

```ts
interface Dataset {
  id: string;            // stable; also the file's basename locally
  name: string;          // display name; renaming changes only this
  fields: DatasetField[];
  /** The prompt this dataset was created from, if any. */
  prompt?: PromptID;     // { id: globalId ?? id, providerId } — no inputs
  createdAt: number;
  updatedAt: number;
}

interface DatasetSummary {
  providerId: string;
  id: string;
  name: string;
  rowCount: number;
  prompt?: PromptID;
  updatedAt: number;
}
```

`prompt` stores `globalId` when the prompt has one, which is the same choice `paramStorageKey`
makes for `localStorage`: it survives moves and renames. The server resolves it at read time
through `promptRegistry.resolve`, like `resolveSpanPrompt` does for spans, so the client always
receives an openable `{ id, providerId }` or no link at all.

The link is metadata, not a constraint. Filling a panel from a row (§I) uses §B's matching rule,
not the link, so an unlinked dataset whose fields fit a prompt *could* be opened in it. v1 offers
"Open in playground" only for the linked prompt, because that's the case with an obvious target;
"Open in…" any matching prompt is an easy later addition.

## D. `NamedInputs`: the one conversion everything goes through

Four flows move inputs around: panel → row, trace → row, row → panel, and trace → panel (the
"Open prompt" fix). Each is **source → named inputs → target**, with §B's rule in the middle.
Write the middle once:

```ts
/** Inputs with the definition that says what each one is. */
type NamedInputs = { def: PropDefinition; input: ExecutionInput }[];

// sources
function fromPanel(prompt: NormalizedPrompt, request: PartialExecuteRequest): NamedInputs;
function fromTrace(recorded: PromptID, current?: NormalizedPrompt): NamedInputs;
function fromRow(dataset: Dataset, row: DatasetRow): NamedInputs;

// targets — each reports what didn't fit, so the UI can say so
function toCells(inputs: NamedInputs, fields: DatasetField[]):
  { cells: Record<string, ExecutionInput>; matched: number; skipped: string[] };
function toPanel(inputs: NamedInputs, prompt: NormalizedPrompt):
  { functionInputs: Record<string, ExecutionInput>;
    executeInputs: Record<string, ExecutionInput>; skipped: string[] };
function fieldsFor(inputs: NamedInputs): DatasetField[];   // schema for "New dataset"
```

It's pure, has no React, and lives in `src/client/components/named-inputs.ts` beside
`combined-inputs.ts`. Every consumer is client-side, and the server only has to validate the
result (§F).

### D.1 From the panel

`fromPanel` pairs `prompt.functionParameters` and `prompt.executeParameters` with what
`toExecutionInput` produces for each slot. This needs a variant of `buildRequest` that **doesn't
enforce required parameters**: a row with an empty `roster` is a legitimate partial row, not an
error. Refactor `buildRequest` into `collectInputs({ requireAll })` so both callers share it.

### D.2 From a playground trace

`recorded.functionInputs[i]` is paired positionally with `recorded.parameterDefinitions[i]`, and
`recorded.executeInputs[name]` with the new `executeParameterDefinitions` (§H). The **recorded**
definitions win over the current prompt's: they're the types the inputs were captured against,
which is the whole reason `execution-inputs.md` §H records them. That also means a row captured
from an old trace keeps its original types, and §B's rule decides honestly whether it still fits.

### D.3 From a production trace — values only

A trace sent by an app through `@evalution/vercel-ai-sdk` or `@evalution/typesafe-sdk` carries
only `functionParameters`, the raw arguments `prompts()` saw. There are no resource refs (there
can't be — the app passed a live `db`), no types, and no names. So:

- Names and types come from the **current** prompt's `functionParameters`, by position. The raw ID
  resolves to a current prompt through the same `promptRegistry.resolve` path, and a trace whose
  prompt no longer resolves can't be added.
- Values become `{ kind: "value", value: jsonToPropValue(raw) }` using the existing
  `src/shared/json-prop-value.ts`.
- Opaque slots (`Db`) get nothing. That's the "values only" decision, and it's correct: the row
  records what the app passed, and §I's fill leaves the panel's own `db` choice in place.

This is the `production trace → the serializable half of its inputs → dataset row` arrow from
`resource-arguments.md` §K. It still can't produce `seededTask(args)` from a production trace;
that's `capture` in the shelved `resource-observation.md` §H.

## E. `DatasetProvider`

```ts
/**
 * A store of datasets: named, schema'd collections of input rows used to
 * exercise prompts. Parallel to PromptProvider and TraceProvider.
 */
export interface DatasetProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;

  listDatasets(): Promise<DatasetSummary[]>;
  getDataset(datasetId: string): Promise<Dataset | undefined>;
  /** A window onto the rows, oldest first — all of them without `options`. */
  listRows(
    datasetId: string,
    options?: { offset?: number; limit?: number },
  ): Promise<DatasetRow[]>;
  /** Row count, and what each field's cells hold one level in — see §J. */
  describeRows(datasetId: string): Promise<DatasetRowsOverview>;

  createDataset(input: {
    name: string;
    fields: Omit<DatasetField, "id">[];
    prompt?: PromptID;
  }): Promise<Dataset>;
  renameDataset(datasetId: string, name: string): Promise<Dataset>;
  deleteDataset(datasetId: string): Promise<void>;

  /** Appends rows, minting ids and timestamps. Cells must name existing field ids. */
  addRows(
    datasetId: string,
    rows: Pick<DatasetRow, "cells" | "source">[],
  ): Promise<DatasetRow[]>;
  deleteRow(datasetId: string, rowId: string): Promise<void>;

  /** Optional — as {@link TraceProvider.watch}. */
  watch?(callback: (event: DatasetChangeEvent) => void): () => void;
}
```

Reads and writes are **one interface**, unlike traces. `TraceProvider`/`TraceSink` split because
spans come from ingestors on a different path from the reads. Dataset writes come from the user
through REST, which is the annotation situation, and annotations live on the provider. The core
CRUD is required rather than optional-by-member: a read-only dataset provider has no motivating
case, and "may omit" on every write would put a capability check in every button.

`fields` on `createDataset` has no ids: the provider mints them. `rows` on `createDataset` isn't
there either — "create from panel" is create-then-`addRows`, two calls from the client, so there's
one way to add a row. Accepted cost: a failure between the two leaves an empty dataset, which is
visible and harmless.

### Two implementations, mirroring the trace pair

| trace | dataset | role |
| --- | --- | --- |
| `TursoTraceProvider({ client })` | `TursoDatasetProvider({ client })` | fs-free, over one injected client; holds *any number* of datasets (keyed by `dataset_id`) — the class a cloud project DB uses as-is |
| `LocalDatabaseTraceProvider({ path })` | `LocalDirectoryDatasetProvider({ dir })` | Node-side; owns paths, lazy creation, and — for datasets — the **one-file-per-dataset** composition |

`LocalDirectoryDatasetProvider`:

- **Lists** by scanning `dir` for `*.db` on each `listDatasets()`, so a file copied in by hand
  shows up on the next refresh without a watcher. It opens each file lazily and **caches one
  client per file**. `LocalDatabaseTraceProvider.ensureReal`'s comment explains why: two sync
  clients over one file fail with "database is busy".
- **Creates** by slugifying the name into an id (`support-tickets`, then `support-tickets-2` on
  collision), making the directory on the first create, opening `<id>.db`, migrating, and calling
  the inner `createDataset`. It enforces one dataset per file: a file holding zero or several is
  reported with an error in the list rather than silently guessed at.
- **Deletes** by closing the client, then unlinking the `.db` and Turso's sidecars (`-wal`,
  `-info`, `-changes`).
- **Gitignore:** when it creates `dir`, it writes `dir/.gitignore` containing `*.db*`. Users are told
  to ignore `.evalution/traces/` nowhere today, and the directory ignoring itself is the only
  version that works without instructions. Worth doing for traces in the same change.
- **Fails like the trace provider does:** a file that won't open or migrate is reported once and
  listed with an error, and it never takes the server down.

## F. Storage

`src/dataset/db/schema.ts`, Drizzle sqlite-core, fs-free like its trace sibling:

```ts
export const datasets = sqliteTable("datasets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  fields: text("fields").notNull(),          // JSON DatasetField[] — one per dataset, size irrelevant
  nextFieldId: integer("next_field_id").notNull(),  // §B's counter
  prompt: text("prompt"),                    // JSON PromptID
  createdAt: real("created_at").notNull(),
  updatedAt: real("updated_at").notNull(),
});

export const datasetRows = sqliteTable("dataset_rows", {
  id: text("id").primaryKey(),               // short random id, not a UUID — see below
  datasetId: text("dataset_id").notNull()
    .references(() => datasets.id, { onDelete: "cascade" }),
  cells: blob("cells").notNull(),            // JSONB Record<fieldId, ExecutionInput>
  source: blob("source"),                    // JSONB DatasetRowSource
  createdAt: real("created_at").notNull(),
}, t => [index("idx_dataset_rows_dataset").on(t.datasetId, t.createdAt)]);
```

**Size is a design constraint here, unlike for most of the schema,** because `dataset_rows` is the
one table that grows without bound. Everything that repeats per row is kept small:

- **Cells and source are JSONB.** They're written with `jsonb(?)` and read with `json(cells)`.
  Tested against the pinned `@tursodatabase/sync@0.7.2` (2026-09-21): the column stores a `blob`,
  `json()` round-trips it byte-for-byte to the original text, `json_extract` reads into it
  directly, and `jsonb('not json')` fails with `malformed JSON`. **Not `blob({ mode: "json" })`:**
  in the pinned drizzle RC that's `Buffer.from(JSON.stringify(v))`, which is JSON *text* in a
  blob column. It's the same size as `text`, isn't JSONB, and adds a `Buffer` dependency to fs-free
  code. The conversion has to happen in SQLite, via `jsonb()`. That last point is a free last line
  of defense under §F's validation. The size saving is modest (124 vs 147 bytes on a two-cell
  sample, about 15%). The larger win is that SQLite doesn't re-parse text on every JSON function
  call, which matters once anything queries into cells. Drizzle has no built-in JSONB column:
  wrap it in a `customType` if `toDriver` can emit `sql\`jsonb(${…})\``, which needs checking
  against the pinned RC, and otherwise write the `jsonb()`/`json()` calls explicitly in the
  provider's two queries. The dataset-level `fields` and `prompt` stay `text`: one row per
  dataset, human-inspectable with `sqlite3`, and no size to win.
- **Short field ids** (§B) make cell keys one or two bytes.
- **Row ids are a short random id** (10 base-62 characters, about 60 bits), not a 36-character
  UUID. They can't be `INTEGER PRIMARY KEY`: a row created offline in one replica must not collide
  with a teammate's once sync arrives (PLAN §3.3), so ids have to be minted independently.
  Ten characters is ample for per-dataset uniqueness.
- **Absent cells aren't stored.** Rows are sparse (§B), so a missing field is a missing key, not a
  `null`.

The remaining overhead is the `ExecutionInput` envelope itself. A typed-in string costs
`{"kind":"value","value":{"kind":"primitive","value":…}}`, about 45 bytes around the payload. §O.5
covers why that stays.

- **Cells are one JSON blob, not a column per field.** Fields are TypeScript types, not SQL
  types. A column per field would turn every schema change into DDL across files the migration
  ledger doesn't know about, and nothing queries into a cell.
- **Migrations follow the trace pattern exactly:** `drizzle.datasets.config.ts` points at
  `src/dataset/db/migrations/`, `scripts/generate-migration-bundle.ts` takes the migrations
  directory as an argument instead of hard-coding the trace one, `bundled.ts` is applied through
  `migrateAsync`, and the ledger table is `__evalution_migrations`. `db:generate` and `db:bundle`
  run both. The bundled-migrations completeness test gets a dataset twin.
- `runMigrations` in `src/trace/db/migrate.ts` is generalized to take the bundle as an argument,
  and `createLocalTursoClient` is imported as-is. Both are already DB-generic and only live under
  `trace/` because that was the first user.
- `reuse lint`: the new migration SQL needs the same treatment `7e03836` gave the trace SQL.

The server validates what it stores. Every cell key must be a field id, and every cell must be a
well-formed `ExecutionInput` (a recursive shape check, no `dataset` variant, `receipt` removed).
Anything else is a 400, not a row that fails later.

## G. Wiring

- `EvalutionConfig.datasetProviders?: DatasetProvider[]`. When omitted, `src/cli/index.ts` builds
  `new LocalDirectoryDatasetProvider({ dir: path.join(rootDir, ".evalution", "datasets") })`,
  using a `rootDir`-relative path for the reason the trace default gives in its comment.
- `startServer` / `setupRoutes` take `datasetProviders`. Neutral handlers go in
  `src/server/handlers/datasets.ts`, in the `annotations.ts` style:

| route | |
| --- | --- |
| `GET /api/datasets` | `DatasetSummary[]` across providers, `prompt` resolved |
| `POST /api/datasets/:providerId` | create `{ name, fields, prompt? }` |
| `GET /api/datasets/:providerId/:id` | `{ dataset, rowCount, fields }`, `prompt` resolved — no rows |
| `GET /api/datasets/:providerId/:id/rows?offset=&limit=` | one page of rows; `limit` capped at 1000 |
| `PATCH /api/datasets/:providerId/:id` | rename |
| `DELETE /api/datasets/:providerId/:id` | delete |
| `POST /api/datasets/:providerId/:id/rows` | add rows (validated per §F) |
| `DELETE /api/datasets/:providerId/:id/rows/:rowId` | delete a row |

- Live updates use the **existing** hot-reload SSE stream: `SSEData` gains
  `{ type: "dataset-changed"; providerId; event: DatasetChangeEvent }`, fed by `watch`, exactly as
  `trace-changed` is. No second stream.
- `src/index.ts` exports `DatasetProvider`, the two implementations, and the types. Everything
  gets doc comments for `npm run docs`.

## H. Traces: the two fixes

1. **`resolveSpanPrompt` keeps the recorded inputs** — `{ ...span.prompt, id, providerId }`
   instead of `{ id, providerId }`. It's one line, and it's the reason "Open prompt" can fill
   anything at all.
2. **Record execute-parameter definitions.** `PromptID` and `PromptSpanInfo` gain
   `executeParameterDefinitions?: unknown[]`, which is additive to the dual-licensed
   `trace-types.ts`. `FilePromptProvider.parameterSnapshot` returns both halves. The field is
   carried by the Vercel and typesafe native telemetry, by `getPromptSpanAttributes`' JSON, and by
   its reader in `otel-attributes.ts`. Without it, D.2 can't type an `executeInputs` entry and
   `toolsContext.db` could never land in a dataset field.

## I. Filling the execute panel from outside

Two entry points, one mechanism: trace → "Open prompt", and dataset row → "Open in playground".

```ts
/** A one-shot request to overwrite the panel, carried on the prompt tab. */
interface PanelFill {
  functionInputs: Record<string, ExecutionInput>;
  executeInputs: Record<string, ExecutionInput>;
  /** Shown in the notice: "Filled from trace 3f2a…" / "Filled from Support tickets, row 4". */
  from: string;
  skipped: string[];
  nonce: number;
}
```

- `PromptTab` gains `fill?: PanelFill`. `openPromptTabRightOf` sets it. If the tab is already
  open, it replaces `fill` with a fresh `nonce` and focuses the tab.
- `PlaygroundExecution` takes `fill`, and an effect keyed on `nonce` runs `fromExecutionInput`
  over each entry (collecting `resourceArgs`, the way `loadStored` does), sets selections, and
  **persists**. The next reload shows the filled panel, not what was there before.
- **Matched slots are overwritten and unmatched slots keep what they had.** This makes a
  values-only production row usable: its `taskInfo` and `roster` land, and the `db` resource you
  already picked stays. The dismissible notice under the header says so ("Filled from trace 3f2a…
  · kept your values for `toolsContext`"), and it names skipped fields ("`legacyFlag` has no
  matching parameter").
- Layout choices are left alone. `combined-execute-inputs.md` §B rule 2 already forces `expanded`
  when filled members disagree.
- A resource cell whose `uri` isn't in this prompt's `inputSources.resources` counts as
  **skipped**, not filled. The resource lives in a `*.playground.ts` this prompt can't see, and
  restoring a chip that can't resolve would only fail at Run.

## J. UI

**Sidebar.** A `DatasetsIcon` button under Traces, `activeSection: "datasets"`, and a
`DatasetList` modelled on `TraceList`: name, row count, the linked prompt's name, and when it was
updated. A `useDatasets` hook modelled on `useTraces` refetches on `dataset-changed`.

**Dataset tab.** A new `DatasetTab { type: "dataset"; providerId; datasetId; label }` in `App.tsx`'s
tab model, rendering `DatasetView`. (As first built, a plain `<table>` of every row; since
2026-09-22 a virtualized grid, below the sketch.)

```
Support tickets                        linked to classify ↗   [ ⋯ ]  rename / delete
┌────┬──────────────────────┬──────────────┬──────────────────┬──────────┬───────┐
│  # │ ticket  string       │ verbose  bool│ db  Db           │ source   │       │
├────┼──────────────────────┼──────────────┼──────────────────┼──────────┼───────┤
│  1 │ "My order never…"    │ true         │ ◆ db             │ playgrnd │ ▶  ✕ │
│  2 │ "Refund please"      │ —            │ —                │ trace ↗  │ ▶  ✕ │
└────┴──────────────────────┴──────────────┴──────────────────┴──────────┴───────┘
```

- Column headers show the field name, with `type.syntax` shortened (`shortSyntax`, full on hover).
- `value` cells get a compact one-line preview (templates show their text), `object` cells show a
  `{…}` preview that expands on hover, and `resource` cells show a chip with the export name plus
  an args summary. The view has no `inputSources`, so there's no resource *label* to use.
- ▶ "Open in playground" appears only when the dataset's `prompt` resolved. It opens the prompt
  tab to the right with a `fill` from `toPanel(fromRow(…))`. (Since 2026-09-22 it lives in the
  details pane rather than in a column.)
- "trace ↗" opens the source trace.
- If fields no longer match the linked prompt's current parameters, a line above the table says
  so ("2 fields no longer match `classify`'s parameters"). The row still opens, and those fields
  are reported as skipped.

**The grid (2026-09-22).** The table is a Glide Data Grid (`@glideapps/glide-data-grid`, the
React 19–compatible `6.0.4-alpha24`, lazy-loaded with `DatasetView`), and rows are never all in
memory:

- `GET …/:id` returns an overview instead of rows; the grid is sized from `rowCount` and pages rows
  in 100 at a time from `GET …/:id/rows` as they scroll into view (`RowPager` in
  `dataset-grid.ts`). A change refetches the overview and the visible pages, serving the stale ones
  until the new ones land so nothing flashes.
- **Columns are paths into cells, found in the data.** A field's `def` is the slot type (`Db`),
  which says nothing about which resource a row picked or what arguments it took, and different
  rows pick different resources. So `describeRows` asks SQLite (`json_each` over the JSONB cells)
  for the keys one level inside each field — a `resource` cell's argument names, an `object`
  cell's property names, and the properties of a **typed-in object value** (`$.value.properties`),
  which is how a trace's recorded object inputs land — **merged by name**, roughly in first-seen
  order. A field with keys gets a group header; clicking it splits the field into one column per
  key. A row without that key shows `n/a`, distinct from a sparse row's `—`. One level only, and
  names only — no argument types — for now.
- **The field keeps a column of its own only when a resource fills it** (`shape.resource`, also
  from `describeRows`), to name *which* resource, since rows may name different ones. A field of
  objects doesn't: its own cell would only ever read `{…}` beside the columns holding what's in
  it.
- **Selecting a row opens it in the details pane** the trace view uses for spans (`DetailsPane.tsx`,
  shared): when it was added, its source, then every field in full — long text wraps, and a
  resource shows its arguments nested beneath it. Open-in-playground and delete live there, and
  only there — the grid has no ▶ column. "trace ↗" in the source column still opens the trace.
- **Expanded fields and hand-resized columns persist per dataset** in
  `localStorage` (`dataset-layout:<providerId>:<datasetId>`), as the trace list's columns do. A
  per-viewer convenience: storage that's unavailable or hand-edited falls back to the default
  layout, and deleting a dataset drops its entry.
- **Sorting and filtering later** name the same paths: a path maps to a JSON path
  (`$."1".args.title.value.value`), so they become `ORDER BY` / `WHERE` on `json_extract` behind
  new `ListRowsOptions` members, and paging stays correct because the server orders.

**Add-to-dataset menu.** One component, `AddToDatasetMenu`, anchored with
`use-anchored-popover.ts` and given `NamedInputs` plus a suggested prompt link:

- It lists every dataset, **linked-to-this-prompt first**. Each shows how much would land
  ("3 of 4 fields"). A dataset with zero matches is shown disabled ("no matching fields"), so it
  reads as a choice rather than a mystery absence.
- "New dataset…" becomes an inline name field, then `createDataset({ name, fields:
  fieldsFor(inputs), prompt })` followed by `addRows`.
- After adding, it confirms with a line naming the dataset and anything skipped.

Where it appears:

- **Playground:** a button on the right of `.pg-exec-header`, across from "Execute", fed by
  `fromPanel`. It's disabled when every slot is empty.
- **Trace:** in `.trace-view-header-actions-full` beside "Open prompt", and in the collapsed
  header menu, fed by `fromTrace`. Shown only when the root span has a prompt with recorded
  inputs or `functionParameters`. For D.3 traces, "New dataset" builds its schema from the
  current prompt's signature.

## K. Non-goals

- **Running a prompt over a dataset** (fan-out, evals, scorers) and with it the `dataset`
  `ExecutionInput` variant. This spec produces rows; consuming them in bulk is the next spec. It
  will have to face `resource-arguments.md` §F (resettable resources serialize a fan-out) and
  `resource-observation.md` §F (scorers want resource timelines).
- In-table cell editing, reordering rows, editing a schema, and hand-typed field types (§B).
  *Partly lifted 2026-09-29:* user-added fields, value-cell editing (inline and in the details pane),
  and appending rows (§P).
- Expected outputs. PLAN §3.2 mentions them, and they'll likely arrive as a field role
  (`role: "expected"`) alongside the schema here, but nothing in v1 reads them.
- Cloud sync, import/export (CSV, JSONL), and watching `.evalution/datasets/` for external changes
  (a rescan on list covers the common case).
- `capture` — recovering resource *arguments* from a production trace
  (`resource-observation.md` §H).

## L. Phasing

1. **Trace fixes and "Open prompt" fills the panel.** §H, `named-inputs.ts` (`fromTrace` and
   `toPanel`), and §I's `PanelFill`. This has value on its own before any dataset exists, and it
   builds half of the conversion layer.
2. **Storage.** Schema, migrations and the bundling generalization, `TursoDatasetProvider`, and
   `LocalDirectoryDatasetProvider`. Testable without UI.
3. **Server.** Config, the CLI default, handlers and routes, validation, and SSE.
4. **Sidebar, list, and `DatasetView`** (read and delete).
5. **Add from the playground.** `collectInputs({ requireAll })`, `fromPanel`, `toCells`,
   `fieldsFor`, `AddToDatasetMenu`.
6. **Add from traces,** including the D.3 values-only path.
7. **Open a row in the playground.** `fromRow` feeding step 1's fill.

## M. Files

- `src/dataset/dataset-provider.ts` *(new)* — the interface.
- `src/dataset/dataset-types.ts` *(new)* — `Dataset`, `DatasetField`, `DatasetRow`,
  `DatasetRowSource`, `DatasetSummary`, `DatasetChangeEvent`. These are re-exported from
  `shared/types.ts`, as trace types are.
- `src/dataset/turso-dataset-provider.ts`, `src/dataset/local-directory-dataset-provider.ts`
  *(new)*.
- `src/dataset/db/schema.ts`, `src/dataset/db/migrations/` *(new)*, and
  `drizzle.datasets.config.ts` *(new)*.
- `src/trace/db/migrate.ts` (bundle as a parameter), `scripts/generate-migration-bundle.ts`
  (directory as an argument), `package.json` scripts.
- `src/config.ts` (`datasetProviders`), `src/cli/index.ts` (default), `src/server/index.ts`,
  `src/server/api-routes.ts` (routes, `resolveSpanPrompt` fix), and
  `src/server/handlers/datasets.ts` *(new)*.
- `src/shared/types.ts` — `DatasetChangedSSEData`, and the re-exports.
- `src/trace/trace-types.ts`, `src/trace/prompt-tracer.ts`, `src/trace/otel-attributes.ts`,
  `src/sdk/vercel-ai-sdk/telemetry.ts`, `src/sdk/typesafe-sdk/telemetry.ts`, and
  `src/prompt/file/file-prompt-provider.ts` — `executeParameterDefinitions`.
- `src/client/components/named-inputs.ts` *(new)*, `AddToDatasetMenu.tsx`, `DatasetList.tsx`, and
  `DatasetView.tsx` *(new)*; `src/client/hooks/useDatasets.ts` *(new)*; `src/client/api.ts`.
- `src/client/components/PlaygroundExecution.tsx` (header button, `collectInputs`, `fill`),
  `PlaygroundContent.tsx` (passes `fill`), `TraceView.tsx` (menu, "Open prompt" passes inputs),
  `App.tsx` (section, `DatasetTab`, `PromptTab.fill`), `styles.css`.
- `src/index.ts` — exports. `.gitignore` gets `.evalution/datasets/` for this repo's own use.
- `docs/config.md` — `datasetProviders`, and where the files live.

## N. Verification

- **Unit, `named-inputs.ts`:**
  - Name *and* `type.syntax` must match, so the same name with a different type is skipped.
  - `toCells` reports skipped names and the matched count.
  - Receipts are stripped.
  - `fromTrace` prefers recorded definitions over the current prompt's.
  - `fromTrace` on a production trace maps raw args by position through `jsonToPropValue`, and
    leaves opaque slots empty.
  - `toPanel` skips a resource cell whose `uri` isn't in scope.
  - The round trip `toPanel(fromRow(row with cells toCells(fromPanel(p))))` restores the same
    `ExecuteRequest`, including a resource with `args` and an object with a resource in one field.
- **Unit, providers:** a shared contract suite run against `TursoDatasetProvider` (over an
  in-memory client) and `LocalDirectoryDatasetProvider` (over a scratch directory — this is
  genuinely file behaviour, so the real FS is justified per `CLAUDE.md`). It covers:
  - Create, list, add, delete, rename.
  - Cascade on dataset delete.
  - Cells with unknown field ids are rejected.
  - Nothing is written to disk before the first create, and `.gitignore` is written with the
    directory.
  - One file per dataset; a hand-copied file shows up on the next `listDatasets`.
  - Delete removes the sidecars.
  - Cells are stored as a `blob` (`typeof(cells) = 'blob'`) and read back equal to what was
    written.
  - Field ids are minted `0`, `1`, … and never reused.
  - Absent cells aren't stored.
  - A corrupt file lists with an error and doesn't throw.
  - Two concurrent first-creates don't open two clients on one file.
- **Migrations:** the bundled-completeness test for the dataset directory; forward-apply over an
  empty file.
- **Server (`api-routes.test.ts`):**
  - `GET /api/traces/:p/:id` returns `prompt.functionInputs` (the regression for §H.1).
  - The dataset routes round-trip.
  - Malformed cells and `dataset`-variant cells get a 400.
  - `prompt` is resolved on read.
  - `dataset-changed` reaches the hot-reload stream.
- **Telemetry:** `executeParameterDefinitions` reads back on the native path and on the OTel path.
- **Playwright (`*.pw.tsx`):**
  - The execute header shows "Add to dataset", and its menu lists a zero-match dataset as disabled.
  - "New dataset…" creates and adds.
  - A `fill` overwrites matched slots, keeps unmatched ones, shows the notice, and persists
    through `localStorage`.
  - `DatasetView` renders value, object, and resource cells.
- **End to end:**
  - In the odin playground, pick `db` and `seededTask` with arguments, then "Add to dataset → New".
  - Open the dataset and see one row with a `db` chip and a `seededTask` chip carrying its args.
  - Click ▶ and see the panel refilled identically.
  - Run it, then from the new trace "Add to dataset" the same dataset: the second row has no
    receipt.
  - Separately, ingest a production OTLP trace for the same prompt, add it, and open it: the
    values land, and your `db` choice stays.

## O. Open questions

1. *Is `type.syntax` equality too strict?* It's the same question as `combined-execute-inputs.md`
   §J.1, with more weight: a row captured months ago was typed by an older checker run, and
   `TaskId` vs `` `tsk_${string}` `` spelling drift makes a field silently stop matching. The UI
   shows skips rather than hiding them, which makes it observable. The real fix is server-side
   `isTypeAssignableTo` against the target prompt's program, which is expensive and deferred.
2. *Should dataset rows ever carry receipts?* §A strips them because rows are recipes. A
   "pin this exact run" dataset, used for regression evals that compare against a recorded trace,
   would want them kept and sent back. If that appears, it's a per-dataset flag and a strip that
   becomes conditional; the storage format doesn't change.
3. *Schema growth.* Adding to a dataset drops non-matching inputs. Should "add" offer to **widen**
   the schema with the unmatched fields? It's cheap to add later: new fields, existing rows stay
   sparse, and no DDL is needed because cells are a blob. Deliberately left out of v1 so a dataset's
   shape changes only when someone asks it to.
4. *Signature drift on the linked prompt.* §J surfaces "N fields no longer match". The natural
   follow-up is "update schema to match `classify`", which is a field rename or retype. It's
   deferred with schema editing.
5. *Should cells use a compact encoding?* After §F, the largest per-cell overhead is the
   `ExecutionInput` envelope: a plain string or number pays about 45 bytes of
   `kind`/`value` wrapping. A storage-only shorthand (a bare JSON primitive in the blob meaning
   `{ kind: "value", value: { kind: "primitive", value } }`) would remove that for the most common
   cell. The cost is a second format that every reader must expand, and the loss of §A's "a cell
   *is* the thing the panel stores" property. Measure first: build a real dataset, compare the
   file with and without the shorthand, and adopt it only if the envelope turns out to dominate.
   It would be a provider-internal change with no wire or interface impact, so waiting costs
   nothing.
6. *Dataset ids vs names.* The id is fixed at creation (the filename), and renaming changes only
   `name`. A dataset renamed from "Tickets" to "Refunds" keeps `tickets.db` on disk, which matters
   only to someone poking at the directory. Renaming the file too is possible (close, rename
   file and sidecars, reopen) if it bothers anyone.

## P. Follow-up (2026-09-29): user-added fields and cell editing

Evals bind expected values from dataset columns (`specs/evals.md` §B.2). The Odin eval needs an
`expectedTitle` column, and no prompt parameter or trace produces one. With every prompt input bound
explicitly (`evals.md` §A), a dataset can also be entirely plain data (`title`, `description`,
`threadMsgs`), with the eval building `seededTask` over those columns rather than storing a
resource ref in each row. Both need fields a person adds and values a person types.

### P.1 Add field

"＋" sits at the right end of the grid's header row. It's Glide's `rightElement`, so it stays put
while the columns scroll. It opens a popover with a name box and a type picker:

- **string**, **number**, or **boolean**. The `def` is built directly: `{ name, optional: true,
  type: { kind: "primitive", syntax: type, base: type } }`. §B objected to typed-in field types
  because a free-form type string has no checker to resolve it. A primitive doesn't need one,
  because its syntax and its structure are the same thing.
- **Same type as a parameter…**: a prompt's function or execute parameter, or a check's parameter
  (`evals.md` §B.4). The field copies that `PropDefinition`, which the checker already resolved in
  a real program, so §B's objection doesn't apply here either. The parameter's name is the default
  field name. This is how a column gets a structured type, such as `threadMsgs:
  readonly Pick<ThreadMessage, "excerpt">[]`, and why a separate JSON type isn't needed yet.
  The linked prompt's parameters are listed first.

```ts
// DatasetProvider
/** Appends a field. Rows are untouched: the new column starts empty. */
addField(datasetId: string, def: PropDefinition): Promise<DatasetField>;
```

The server accepts a primitive `def` only in the exact shape above. It accepts any other `def`
only if it arrived from a parameter lookup the server did itself (`POST …/fields` with
`{ from: { providerId, promptId | checkUri, half?, path } }`), never as a hand-written structure.

Glide's `onColumnAppended` is the wrong hook for this. It fires when the user tabs past the last
column mid-edit, and a field needs a name and type before it can exist.

- **Uniqueness uses §B's key.** A field with the same name and syntax as an existing one is
  rejected ("`title: string` already exists"). The same name with a different type is allowed, as
  it is for derived fields.
- **It matches like any field.** A user-added `title: string` matches a prompt's `title: string`
  parameter by §B's rule. So it fills the panel through "Open in playground", and pre-fills an eval
  binding (`evals.md` §F.1).
- **No rename, retype, or removal yet.** `nextFieldId` already makes removal safe to add later
  (§B). Renaming a field can quietly break the evals bound to it, so it waits for a reason.

### P.2 Cell editing: inline in the grid, and in the details pane

**Inline, with Glide's own editors**, for the cells they can edit faithfully. That means a
top-level field column (not a split path, §J) whose field type is a primitive with base
`string`, `number`, or `boolean`, and whose cell is empty or holds a `value` that's a plain
primitive. Those cells are served as editable `Text`, `Number`, or `Boolean` grid cells
(`allowOverlay: true`, `readonly: false`). Everything else stays read-only in the grid, including a
string cell holding a template: the text editor would flatten its interpolation tokens.

- **`onCellsEdited`** receives every edit as one batch: a single edit, a paste over a range, or a
  fill-handle drag. The batch is grouped by row into one `updateRows` call. `onPaste` is left at
  its default, so pasting a column of expected values from a spreadsheet just works, and cells
  outside the editable set are skipped.
- **Delete/Backspace over a selection clears it.** Glide routes the cleared cells through the same
  batch, and an empty value becomes `null`.
- **`validateCell`** rejects a value that doesn't fit the cell's base type (Glide's `Number` cell
  already parses) before it's sent.
- **Optimistic.** The edited page in `RowPager` is patched at once, and the `dataset-changed`
  refetch replaces it; a patched page outranks any fetch already in flight, which may predate the
  edit. A failed save shows the error under the header and reloads the visible rows from the
  server, dropping every optimistic edit on them (no per-edit undo: two overlapping failed edits
  can't be unwound in order).

**In the row details pane** for everything inline can't do. Every `value` cell of any field gets
`ItemEditor` against the field's `def`, as the panel does, and commits on blur or Enter rather than
per keystroke. That covers templates, objects, and arrays such as `threadMsgs`. An empty cell of
any field can be given a value the same way. `object` and `resource` cells stay read-only in both
places: editing them means offering resources, which needs a prompt's `inputSources`, and a dataset
has none (§J). A read-only cell can still be cleared.

**Clearing a cell removes its key**, keeping rows sparse (§A).

```ts
// DatasetProvider
/**
 * Sets or clears cells on several rows at once. `null` clears. Only `value`
 * cells may be set: nothing in the dataset view can produce any other kind.
 */
updateRows(datasetId: string, updates: { rowId: string; cells: Record<string, ExecutionInput | null> }[]): Promise<void>;
```

The server validates each set cell against its field. For a primitive field, the value's
`PropValue` must be a primitive of that base. For any other field it gets the shape check `addRows`
already applies. Both providers merge into the JSONB blob (`json_patch`) in one transaction, so an
edit rewrites only the rows it touches.

### P.3 Rows and datasets by hand

- **Glide's trailing row adds rows.** `trailingRowOptions: { hint: "New row", sticky: true }`
  shows a blank row after the last one. Clicking it, or pressing ↓ past the last row while editing,
  calls `onRowAppended`, which `addRows` an empty row (no cells, no `source`, which already reads
  as "added by hand") and returns `"bottom"`. Glide then waits for `rows` to grow before focusing
  the new row's cell. It gives up after about half a second, so `DatasetView` bumps the overview's
  `rowCount` optimistically rather than waiting for the server round trip.
- **"New dataset…" in the sidebar** creates a dataset with a name, no fields, and no prompt link.
  With P.1 and P.2 it can be filled entirely by hand.

### P.4 Wire and phasing

`POST /api/datasets/:p/:id/fields` (`{ name, type }` or `{ from }`), and
`PATCH /api/datasets/:p/:id/rows` (the batch). The trailing row reuses the existing add-rows
route. All of them emit `dataset-changed`, so an open grid refetches its overview and visible pages
as it does today.

1. `addField` and `updateRows` in both providers, with contract tests in
   `dataset-provider-contract.ts`: minted ids stay unique, duplicate keys are rejected, a merge
   leaves other cells untouched, `null` removes the key, any cell kind `addRows` takes can be set, and a
   batch is all-or-nothing.
2. Routes, server validation, and the parameter lookup behind `{ from }`.
3. UI: the "＋" field popover, inline editors with batch edits, paste and delete, the trailing row,
   details-pane editing, and "New dataset…" in the sidebar.

This doesn't depend on evals and can ship first. Evals depend on it only for the Odin example.
Inline editing is the one piece to cover with a Playwright component test: an edit, a paste over a
range, and an append that focuses the new row all need the real grid.
