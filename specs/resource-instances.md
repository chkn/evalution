# Proposal: Named resource instances and a Resources section

> **Status: PLAN, agreed 2026-10-08.** Nothing here is implemented yet. §L's proposed answers were
> accepted, and the inline `resource` variant is removed outright rather than kept (§A.1).
> It builds on `specs/execution-inputs.md`, `specs/resource-arguments.md` (whose §Q.2 anticipated "named
> instances") and `specs/evals.md` §B.2.

## Context

Resources work, and arguments made them parameterisable. One case still can't be expressed:
**side effects that don't feed any slot, assembled from modular pieces that need each other's
outputs.**

The motivating example is a task hierarchy for odin. `list_tasks` reads it back through a tool, so
no prompt slot ever takes the child tasks. The prompt takes `taskId` (the root) and nothing else:

```
root   = seededTask({ title: "Todo app" })                         → taskId slot
child1 = seededTask({ title: "Add drag reorder", parentId: root.taskId })   (no slot)
child2 = seededTask({ title: "Persist to localStorage", parentId: root.taskId })   (no slot)
```

Three things stop this today. The first two are why the user reported it. The third came up while
reading the registry.

1. **Nothing runs unless a slot reads it.** Resources are acquired lazily by
   `resolveExecutionInputs` as slots resolve. An unselected resource is never created, so
   `child1` cannot exist.
2. **A resource has at most one instance per run, as far as the panel is concerned.** The wire
   allows two bindings of one URI with different `args`, but the panel holds arguments per URI
   (`ResourceArgs`, `resource-arguments.md` §I). Even on the wire, an instance's identity *is* its
   recipe (`canonicalArgumentKey`), so two siblings with identical arguments collapse into one,
   and editing a text field changes which instance a reference means.
3. **The registry rejects the hierarchy outright.** Cycle detection runs on the resource object,
   ignoring the argument key (`resource-registry.ts`, `instantiate`):
   `chain.some(c => c.resource === target)`. A child whose `parentId` argument is
   `seededTask.taskId` puts `seededTask` in its own chain, so it fails with
   `Resource dependency cycle`. `resource-arguments.md` §D chose this deliberately, on the grounds
   that "a resource that recursively seeds itself with different arguments … does not exist". This
   is that case.

**The ask:** a **Resources** section at the top of the playground's Execute panel, the eval's
Inputs panel, and a dataset row's details, sharing one implementation. It lists:

- every resource selected for a slot,
- their code-wired dependencies (`db`), where any arguments they take can be configured,
- resources added with no slot binding at all, which run for their side effects,
- several instances of one resource, each with a name, so a slot (or another instance's
  argument) can pick a specific one.

---

## A. The model: a run declares named instances; slots reference them

Today a run is a set of **slot bindings**, and resources appear *inside* them, inline, identified
by recipe. The proposal adds a second, sibling part to every run: a map of **named instances**.
Slots and arguments then refer to instances by name.

```ts
/** One resource instance a run creates, whether or not anything reads it. */
export interface ResourceInstanceInput {
  /** The resource's root `ResourceInfo.uri`. Never an output URI. */
  uri: string;
  /** Values for its declared arguments, by parameter name. */
  args?: Record<string, ExecutionInput>;
  /**
   * Code-wired dependency key → instance name, only where the run has more than one
   * instance of that dependency's resource (§D). Usually absent.
   */
  deps?: Record<string, string>;
  /** Recorded on every run, sent back only by a replay. Same contract as today's (§F). */
  receipt?: unknown;
}

export type ExecutionInput =
  | …                                   // value, object, dataset, input: unchanged
  // `{ kind: "resource", uri, args, receipt }` is removed (§A.1)
  /** An instance declared in the run's `resources`, or one of its outputs. */
  | { kind: "instance"; name: string; output?: string };
```

The hierarchy, as a request:

```jsonc
{
  "resources": {
    "root":   { "uri": "tasks.ts#seededTask", "args": { "title": { "kind": "value", … } } },
    "child1": { "uri": "tasks.ts#seededTask", "args": {
                  "title":    { "kind": "value", … },
                  "parentId": { "kind": "instance", "name": "root", "output": "taskId" } } },
    "child2": { "uri": "tasks.ts#seededTask", "args": { … same parentId … } }
  },
  "functionInputs": [ { "kind": "instance", "name": "root", "output": "taskId" } ]
}
```

What the change buys:

- **Identity is the name, not the recipe.** `child1` and `child2` stay two tasks even with
  identical arguments. Editing an argument changes what an instance *does*, not which instance a
  reference means. That is the same split `resource-arguments.md` §C made between URI and `args`,
  carried one level further.
- **Unbound instances are ordinary entries.** Every instance in `resources` is created when the
  run starts, whether or not anything references it. "Side effect only" isn't a separate concept:
  it's an instance nobody reads.
- **Referencing another instance's output is one small node**, not a copy of its recipe. Today
  `parentId` would have to repeat `root`'s whole `{ uri, args }` inline and rely on the memo key
  matching. That's the drift problem `evals.md` §B.2 invented `input` to avoid for slots.
- **Arguments are stored once per instance**, not stamped onto every reference. The panel's
  `ResourceArgs`/claims machinery, which works out which chip "owns" the form, is no longer needed
  (§H).
- **`instance` is the same kind of node as `input`.** Both say "the value something else in this
  run produced", and both resolve through the lease, so the same instance comes back.

### A.1 The inline `resource` variant is removed

`{ kind: "resource", uri, args, receipt }` goes away entirely. Nobody depends on stored traces,
rows or evals yet, so there's nothing to migrate and no compatibility path to carry. Anything in
`localStorage`, a local dataset or a saved eval that still holds the old node is treated like any
other unparseable stored input: a slot holding it restores empty, and the server rejects it with a
400 naming the slot.

Dropping it, rather than keeping it as an anonymous instance keyed by recipe, removes a lot:

- **One resolution path.** No anonymous instances, so the lease memoizes only by instance name.
  `canonicalArgumentKey`, `ResourceBinding.key` and the `uri@key` receipt keys all go.
- **One cycle rule.** Cycles are checked on instance names alone. The resource-object rule, and the
  special case for keeping it on inline references, both go.
- **No hoisting.** The client never has to turn inline references into instances on load, so
  `hoistInlineResources` and its tests never get written.
- **Receipts live in one place**, on the instance. `stampReceipts` no longer walks slot trees
  looking for resource nodes.
- **`args` exist in exactly one place.** The client's `resourceArgsFor` stamping, and the
  last-writer-wins merge in `fromExecutionInput`, go.

### A.2 Names

- **Default name is the export name** (`seededTask`), suffixed `2`, `3`… on collision. Users
  rename to something meaningful (`root`, `child1`).
- **Grammar:** `[A-Za-z_][A-Za-z0-9_-]*`. No dots, because the UI shows outputs as `root.taskId`.
- **Renaming rewrites every reference in the same scope** (slots, other instances' args, check
  args, a row's cells). This is a pure function over the editor state (§H).
- **Why names rather than opaque ids with a display label:** names are what makes a recorded
  trace, a dataset row and an eval binding readable (`taskId ← root.taskId`). They also let an
  eval refer to an instance each *row* declares (§E). The cost is that a rename has to rewrite
  references. Within one scope that's mechanical. Across scopes (an eval naming a row's instance)
  it can't be done, and §E says what happens instead.

## B. Server: instances are acquired eagerly, keyed by name

`resolveExecutionInputs` gains the run's instances in its `ResolutionContext`:

```ts
interface ResolutionContext {
  row?: Pick<DatasetRow, "cells">;
  bindings?: InputBindings;
  /** The run's named instances: eval-level merged with row-level (§E), or the panel's. */
  instances?: Record<string, ResourceInstanceInput>;
}
```

And the lease gains one entry point beside `acquire`:

```ts
/** Creates (or reuses) the named instance, resolving its args under the same context. */
acquireInstance(name: string, spec: ResourceInstanceInput, binding: ResourceBinding): Promise<unknown>;
```

Rules:

1. **Eager.** Before resolving slots, the resolver acquires *every* instance in
   `context.instances`, in parallel. References between instances order them naturally: `child1`
   awaits `root` because its `parentId` argument resolves through it. Slot resolution then hits
   the memo.
2. **Memo key is the instance name** for run-scoped resources. A run-scoped instance map becomes
   `Map<name, Instance>`. Server-scoped resources keep their single per-process instance, and reset
   locks and disposal work as they do now.
3. **Cycle detection runs on instance names, not on the resource object.** `child1 → root` is two
   instances of one resource, so it is allowed. `root.parentId ← child1.taskId` together with
   `child1.parentId ← root.taskId` is a cycle and fails, naming the instances. Code-wired
   dependencies (`inputs: { db }`) keep today's resource-object check, since an undeclared
   dependency has no name.
4. **Validated up front, as a 400**, together with the existing `input` checks: an `instance` node
   naming a missing instance, an invalid name, a cycle among instances, or two instances of a
   `server`-scoped resource. A server-scoped resource has exactly one instance per process, so two
   names would alias one object, which is never what someone meant. The panel doesn't offer it.
   Output keys are still checked at acquire time by the existing
   `no output at '…'` error.
5. **Receipts are recorded per instance**, keyed by name: `lease.receipts()` returns
   `Record<name, unknown>`, and the route writes each one onto its entry in the recorded
   `resources` map (§F). Code-wired dependency instances that were never declared (the anonymous
   `db` fallback in §D) record under their URI, as now.

Nothing about `create`, `ResourceInstance`, arguments, validation, `reset` or scope changes for
resource authors. **This is invisible in playground modules.**

## C. Where `resources` lives on every surface

| Surface | Today | Adds |
| --- | --- | --- |
| `ExecuteRequest` | `functionInputs`, `executeInputs` | `resources?: Record<string, ResourceInstanceInput>` |
| Playground `StoredInputs` (`localStorage`) | same two | `resources?` |
| `EvalInputs` (JSON column `evals.inputs`) | same two | `resources?`. No migration, it's JSON |
| Check bindings (`EvalCheck.args`) | `ExecutionInput`s | may contain `instance` nodes |
| `DatasetRow` | `cells` | `resources?`. New nullable `dataset_rows.resources` blob, plus the local-directory provider's file shape |
| `DatasetRowUpdate` | `cells` | `resources?: Record<string, ResourceInstanceInput \| null>` |
| `eval_row_results.row_cells` snapshot | cells | the row's `resources` too, so a result shows what it ran with |
| `PromptID` / recorded trace inputs | `functionInputs`, `executeInputs`, defs | `resources?`, with receipts stamped |
| `NamedInputs` flows (`named-inputs.ts`) | slot inputs | carry `resources` alongside (panel ↔ row ↔ trace) |

The `dataset_rows` column is the only real schema migration. Every other row in the table is a
new optional field on an existing JSON value.

## D. Dependencies

A code-wired dependency (`inputs: { db }`) is resolved by the registry today with no binding and
key `""`. The section shows dependencies, and the user wants to be able to configure their
arguments. So the rule becomes:

> When resolving a code-wired dependency of a named instance, the registry uses the instance of
> that resource **declared in the run**, if there is one. If there are several, it uses the one
> `deps` names. If there are none, it falls back to today's anonymous key `""`.

- **The panel shows dependencies derived from what's selected**, transitively, using a new
  `ResourceInfo.dependencies?: Record<string, string>` (input key → URI). The provider already
  partitions `inputs` into dependencies and parameters, so this costs nothing to compute. A derived
  dependency isn't stored. It's a read-only row ("◆ db · shared · used by root, child1,
  child2"), with a preview of its value where `ResourceInfo.value` already provides one.
- **A dependency with arguments gets a form**, and editing it materialises a stored instance named
  after its export. Its arguments have to be stored somewhere, and an instance is that place.
  Under the rule above, every dependent then uses it. (Server-scoped resources still can't take
  arguments, so in practice this means run-scoped dependencies like a per-run workspace.)
- **Several instances of one dependency are a later step (§K.5).** Then each dependent shows a
  small picker for that input (`db: [db ▾]`), stored in `deps`. This is the "rebind a
  resource-valued input" that `resource-arguments.md` §M left out, restricted to instances *of
  the same resource*. That keeps it type-safe by construction, which was §M's reason for
  deferring it.

## E. Evals and dataset rows: two layers, one namespace

An eval run assembles one run per row. Its instances are the eval's `resources` merged with the
row's `resources`, in a single namespace, so either layer can reference the other's instances by
name:

- **Eval-level** instances apply to every row: "seed this fixture workspace for every case".
- **Row-level** instances belong to that case: this row's hierarchy. A row cell, or the eval's
  `taskId` binding, can say `instance root.taskId`, and each row supplies its own `root`.
- **On a name collision the row wins.** That lets an eval define a default `root` that particular
  rows override. It also means a typo can shadow something silently, so the run's recorded
  `resources` (§F) always shows the merged result, and eval validation reports a reference that
  names an instance **no** row and not the eval declares. (The alternative, treating any collision
  as an error, is open question §L.1.)
- **Renames don't cross layers.** Renaming `root` in one row's details rewrites that row's cells
  only. An eval binding that named `root` then fails for that row with
  `Row 12: no resource instance 'root'`. It's an `error`, not a `fail`, as `evals.md` §B.3 already
  treats bad bindings.

Copying between surfaces carries instances along. "Add to dataset" from the panel writes the
panel's `resources` into the new row, so the instance references in its cells still resolve.
"Fill from row" loads the row's instances into the panel's section. A playground trace →
row/panel round trip carries `resources` with its receipts stripped, as cells already are.

## F. Traces and replay

The recorded inputs gain `resources`, with each instance's receipt stamped on, next to
`functionInputs`/`executeInputs`. Replay is still "POST what was recorded". The hierarchy now
reproduces properly: `root`'s receipt brings back its id, and `child1.parentId` is a *reference*
to `root.taskId`, not a copied string, so it follows. If the hierarchy had been written as copied
ids, the replay's children would point at the original run's parent.

## G. UI: the Resources section

```
Resources                                              [ + Add resource ]
┌────────────────────────────────────────────────────────────────────────┐
│ ◆ db         Local D1 (.wrangler state) · shared       dependency     │
│              used by root, child1, child2                              │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ root  ✎    Seeded task · per run                               [⋯] │
│              → taskId, toolsContext.*.rootTaskId                       │
│   title        [ Todo app                       ]                      │
│   status       [ triaged                        ]                      │
│   parentId     [                                ]  ⋯                   │
├────────────────────────────────────────────────────────────────────────┤
│ ◆ child1  ✎  Seeded task · per run                               [⋯] │
│              not bound to a slot: runs for its side effects            │
│   title        [ Add drag reorder               ]                      │
│   parentId     [ ◆ root.taskId                  ]  ⋯                   │
└────────────────────────────────────────────────────────────────────────┘
taskId *                                       [ ◆ root.taskId        ⋯ ]
```

- **One card per instance**, then derived dependencies. A card shows the editable name, the
  resource label, scope, what references it ("→ taskId") or that nothing does, and the argument
  form. Removing an instance asks first if anything references it, then clears those references.
  The `[⋯]` menu holds Rename, Duplicate (the quickest way to make `child2`) and Remove.
- **Argument forms are `ExecutionInputEditor`s, as today**, so an argument can be a typed value, an
  output of another instance, another slot (`input`), or a column (in an eval). Instances are
  excluded from their own forms and from any form that would close a cycle, the same way
  `resource-arguments.md` §H already excludes self-dependency.
- **The slot picker gets a "Resources in this run" group first**, listing instances with their
  outputs as a submenu (`root ▸ Task ID`). Below it, **"New ▸"** holds the existing catalog tree.
  Picking from the catalog adds an instance with the default name *and* binds the slot. That
  keeps today's one-click flow: picking `seededTask.taskId` for `taskId` and then `root ▸ Title`
  for `taskInfo` still gives one task.
- **A chip in a slot is only a reference** (`◆ root.taskId`), and clicking it scrolls to the card.
  Forms never appear under chips any more, so "same instance as `taskId` above" goes away.
- **Unbinding a slot doesn't remove the instance**, because instances outliving bindings is the
  point. The card switches to "not bound to a slot", which is visible at the top of the panel, so a
  forgotten instance doesn't quietly keep seeding rows. (§L.2 has the alternative of auto-pruning
  instances the picker created.)
- **"+ Add resource"** opens the same catalog `SourcePicker` uses, filtered to root resources.
  Server-scoped and static resources that already have an instance are disabled, with the reason
  as a tooltip.
- **Placement:** above the slots in the playground panel and the eval Inputs panel. In row details
  it goes above the fields, with the same commit-on-blur behaviour `RowFields` already uses for
  typed edits, and immediate commits for add, remove and rename.
- **Empty state:** when no instances or dependencies exist, the section collapses to the header and
  its Add button, so prompts without resources look exactly as they do now, apart from one row.

## H. Sharing the code

All three surfaces currently hold the same state in three slightly different ways
(`PlaygroundExecution` lines 215–370, `EvalView` 120–150 and 420–440, `DatasetRowDetails`
130–260). Each one re-derives `ResourceArgs`, runs `computeClaims`, and builds its own
`ResourceArgsContext`. The plan replaces that with:

- **`run-resources-state.ts`** (pure, unit-tested; the client counterpart of §A):
  - `InstanceSelections = Record<name, { uri; args: Selections; deps?: Record<string,string> }>`,
    which replaces `ResourceArgs`;
  - `toWireResources` / `fromWireResources`;
  - `addInstance`, `renameInstance` (rewrites every reference in the given selections),
    `removeInstance`, `duplicateInstance`, `referencesTo`, `derivedDependencies`,
    `excludedFromArgs` (cycle-safe sources for a card's form).
- **`ResourcesSection.tsx`**: a controlled component,
  `{ instances, onChange, resources, resourceSlots, describePseudo, referencedBy }`. Persistence
  stays with each surface: `localStorage`, eval save, row commit.
- **`pseudo-sources.ts` gains `instanceUri(name, output?)`** and maps it to and from
  `{ kind: "instance" }` in `pseudoInput`/`pseudoUriOf`, the same way columns and `input` slots
  already go through the picker. The picker group comes from the instances plus `functionSlots`
  matches (an instance of `seededTask` fits wherever `seededTask.taskId`'s URI fits), so **no new
  server-side matching** is needed.

Removed: `computeClaims`, `ClaimOwner`, `ResourceArgsContext.claimed`/`resourceArgs`/`depth`,
`ResourceArgumentsForm`, `MAX_RESOURCE_ARG_DEPTH`, `resourceArgsFor`'s recursion, and the
"same instance as" note. `ResourceArgsContext` shrinks to what an editor needs for chips
(`instances`, `describePseudo`). That's a net deletion of several hundred lines across
`resource-args-context.ts`, `execution-input-state.ts`, `SourceRow.tsx` and the three surfaces.

## I. Alternatives considered

**Keep instances inline, and add `instance?: string` to the `resource` node as a memo-key
discriminator.** It's the smallest server change. But unbound side effects still have nowhere to
live, arguments are still duplicated on every reference, `parentId` still repeats `root`'s whole
recipe, and the panel keeps the claims machinery. Rejected.

**Make the section a UI over today's wire**: instances are the distinct `(uri, args)` pairs,
plus a `sideEffects: ExecutionInput[]` list. Identical siblings still collapse, a rename has
nothing to attach to, and a child still trips the cycle rule. Rejected.

**One resource per hierarchy** (`seededTaskTree` taking `tasks: { key, title, parentKey? }[]`).
This **works today with no platform change**, and for a hierarchy that is pure data it's a good
pattern to document. It doesn't cover the general case: it can't mix different resources (a task,
a user, a message thread); outputs are declared statically, so an inner node's id can't be offered
to a slot; and every new shape needs a new tree resource. Recommended as a pattern, not as the
answer.

**A `setup()` playground export** run before every prompt. It duplicates the resource lifecycle
(scope, reset, dispose, receipts) for no gain, and it isn't per-run configurable. Rejected.

**Opaque instance ids with display labels.** Renames become free, but every recorded trace,
dataset row and eval binding then reads `r3.taskId`, and an eval can't refer to a per-row instance
by meaning. Rejected (§A.2). Open question §L.3 keeps it under review.

## J. Non-goals

- Ordering side effects that have no data dependency between them. Instances run in parallel, and
  a reference is the only ordering. Nothing needs an `after:` field yet.
- Showing row resources in the dataset *grid*. A count badge at most. The details pane is where
  they're edited.
- Rebinding a dependency to a *different* resource. §D only rebinds between instances of the same
  resource.
- Server-scoped resources taking arguments. That's still refused (`resource-arguments.md` §Q.1).

## K. Phasing

1. **Server.** `ResourceInstanceInput`, the `instance` variant, `ExecuteRequest.resources`, eager
   acquisition, name-keyed memo, instance-identity cycle rule, 400 validation, the dependency rule
   (§D, without `deps`), per-instance receipts and recording. `ResourceInfo.dependencies`. Testable
   end to end with a hand-written request seeding odin's hierarchy.
2. **Shared client state and `ResourcesSection`**, adopted by the playground panel: picker group,
   deleting the claims machinery.
3. **Evals.** `EvalInputs.resources`, the section in the Inputs panel, instance references in check
   args, and the eval runner passing instances into `ResolutionContext`.
4. **Datasets.** `DatasetRow.resources` (Turso migration plus the local-directory provider),
   `updateRows`, the section in row details, `named-inputs.ts` flows, eval/row merge (§E), and
   the `eval_row_results` snapshot.
5. *(when wanted)* `deps`: several instances of a dependency, with the per-input picker.

Steps 1–2 are enough for the odin hierarchy in the playground. Step 4 is what makes it a dataset
case.

## L. Questions (decided 2026-10-08)

1. **Row/eval name collision: row wins, or an error?** Decided: row wins (§E), so an eval can
   carry defaults. The cost is silent shadowing.
2. **Should instances the picker created be pruned when their last reference goes?** Decided: no.
   Instances stay, labelled "not bound to a slot". Auto-pruning matches today's feel (choosing
   another source for a slot makes the old resource disappear), but it needs a stored `auto` flag
   and makes "why did my instance vanish" possible.
3. **Names or ids** (§A.2, §I). Decided: names.
4. ~~**Should the inline `resource` variant be deprecated from the wire eventually?**~~ **Decided:
   removed now** (§A.1). Nothing stored needs it.
5. **Does `input` (slot → slot) still earn its place?** Decided: yes. `toolsContext.*.rootTaskId ←
   input taskId` says "whatever `taskId` is", which stays correct when `taskId` is bound to a
   column instead of an instance. The two overlap but do different jobs.

## M. Files

- `src/shared/types.ts`: `ResourceInstanceInput`, the `instance` variant,
  `ExecuteRequest.resources`, `ResourceInfo.dependencies`.
- `src/prompt/execution-inputs.ts`: `ResolutionContext.instances`, eager acquisition, the
  `instance` case, validation, `stampReceipts` for instances.
- `src/shared/input-references.ts`: instance references in cycle checks and `inputReferenceProblems`.
- `src/prompt/playground/resource-registry.ts`: `acquireInstance`, the `@name` key, the
  instance-identity cycle rule, the dependency-resolution rule, per-instance receipts.
- `src/prompt/file/file-prompt-provider.ts`: `ResourceInfo.dependencies`, and passing
  `resources` through `resolveInputs`.
- `src/server/api-routes.ts`: accepting and recording `resources`.
- `src/trace/trace-types.ts`, `src/trace/prompt-tracer.ts`, `src/sdk/vercel-ai-sdk/telemetry.ts`,
  `src/trace/otel-trace-ingestor.ts`: `resources` on recorded inputs.
- `src/eval/eval-types.ts`, `src/eval/eval-runner.ts`, `src/shared/eval-problems.ts`:
  `EvalInputs.resources`, the eval/row merge, validation.
- `src/dataset/dataset-types.ts`, `turso-dataset-provider.ts` plus a migration under
  `src/dataset/db/migrations/`, `local-directory-dataset-provider.ts`,
  `dataset-provider-contract.ts`: `DatasetRow.resources`, `updateRows`.
- `src/client/components/run-resources-state.ts` *(new)* and `ResourcesSection.tsx` *(new)*.
- `src/client/components/pseudo-sources.ts`, `SourcePicker.tsx`, `source-tree.ts`: instance URIs
  and the "Resources in this run" group.
- `src/client/components/PlaygroundExecution.tsx`, `EvalView.tsx`, `DatasetRowDetails.tsx`,
  `dataset-row-editing.ts`, `named-inputs.ts`: adopting the section.
- `src/client/components/SourceRow.tsx`, `ExecutionInputEditor.tsx`, `resource-args-context.ts`,
  `execution-input-state.ts`: removing per-chip argument forms and claims.
- `docs/`: the resource authoring guide gains "several instances" and "side-effect-only
  resources", and the tree-resource pattern from §I.

## N. Verification

- **Registry (`vitest`, `MemoryFileProvider`):** two named instances of one resource with
  identical args run `create` twice. An instance whose argument references another instance of
  the *same* resource resolves, which is the hierarchy regression for problem 3 in the Context. A
  two-instance reference cycle fails with both names. An instance nobody references is still
  created and disposed. Slots referencing an instance hit the memo, so `create` runs once. A
  dependency resolves to the run's declared instance of that resource and gets its args. A
  server-scoped resource declared twice is a 400, and so is an old inline `resource` node. Existing
  registry tests that use inline references are rewritten to declare instances.
- **Receipts and replay:** recorded `resources` carry per-instance receipts. POSTing them back
  reproduces `root`'s id, and `child1.parentId` matches it.
- **Client state:** `renameInstance` rewrites slot, argument and check references, and nothing
  else. `removeInstance` clears references. A stored selection holding an old inline node restores
  as an empty slot rather than throwing.
- **Evals and datasets:** row instances shadow eval instances. An eval binding to a name a row
  lacks gives that row an `error` naming it. "Add to dataset" carries instances, and "Fill from
  row" restores them.
- **Playwright (`*.pw.tsx`):** adding a resource with no slot shows the card as unbound. Picking
  from "New ▸" adds an instance and binds it. A second slot picking `root ▸ Title` reuses it.
  Duplicate, then rename, updates every chip. The same `ResourcesSection` renders in the panel,
  the eval Inputs panel and row details (one harness per host).
- **End to end:** in odin's playground, add `root`, `child1` and `child2` with `parentId` set to
  `root.taskId`, bind only `taskId`, run, and see `list_tasks` return the three-node tree in the
  trace.
