# Proposal: Resource arguments, receipts, and `reset`

## Context

`specs/resource-hierarchy.md` shipped, and the odin playground now seeds tasks through a
helper that stamps out one resource per task:

```ts
// .evalution/playground/tasks.ts
function seededTask<const T extends Omit<CreateTaskOptions, "workspaceId">>(taskInfo: T) {
  return resource({
    group: "Seeded Tasks",
    label: taskInfo.title,
    inputs: { db },
    outputs: { taskId: "Task ID", ...(Object.fromEntries(Object.keys(taskInfo).map(k => [k, k]))) },
    create: async ({ db: { db, workspaceId } }) => {
      const { taskId } = await createTask(db, { workspaceId, ...taskInfo });
      return { value: { taskId, ...taskInfo } };
    },
  });
}

export const task_todoApp = seededTask({
  title: "Todo app",
  status: "triaged",
  description: "Build a todo list web app. You should be able to add, edit, complete, and re-order todos.",
});
```

This works, and it is pleasant to write — §B of `specs/resource-hierarchy.md` anticipated the
library of tasks and the grouped picker renders it correctly. But the helper has split one
thing into two that do not belong together:

- **`createTask(db, …)`** is code. Nothing but a running process can produce a `taskId`.
- **`{ title, status, description }`** is *data*. It is three strings checked into a `.ts` file
  because that was the only place to put them, which is exactly what
  `specs/execution-inputs.md` §C said not to do.

Being data, it wants to be a **dataset row**: written from a production trace rather than typed
out, iterated over for an eval, varied independently of the prompt. Being stuck in code, it is
none of those.

**The ask:** a resource may declare **arguments**. `seededTask` stops being a helper that mints
a dozen resources and becomes one resource that takes `{ title, status, description }`.
Choosing it in the execute panel adds its parameters to the panel, where each can be typed in,
filled by another resource, or — once datasets exist — bound to a dataset column.

**And the ask behind that one:** make a resource **reproducible**. Arguments are half of what a
run is; the other half is the identity a run mints for itself — the `taskId` nobody supplied. If
`create` is handed back the receipt it wrote last time (§E) and runs against a database reset to a
known state (§F), then a trace carrying `{ uri, args, receipt }` for every resource it touched is
a complete recipe, and replaying it from the playground is a POST of what is already recorded.

```ts
export const seededTask = resource({
  group: "Seeded Tasks",
  label: "Seeded task",
  inputs: {
    db,
    title: z.string(),
    status: z.enum(["triaged", "open", "done"]).default("triaged"),
    description: z.string().optional(),
  },
  outputs: { taskId: "Task ID", title: "Title", status: "Status", description: "Description" },
  create: async ({ db: { db, workspaceId }, ...task }) => {
    const { taskId } = await createTask(db, { workspaceId, ...task });
    return { value: { taskId, ...task } };
  },
});
```

---

## A. Why this comes before datasets, not after

The tempting order is the other way round: build datasets, let a row's columns fill a prompt's
slots, and leave resources alone. It does not work for the case that motivates both, and
seeing why fixes the layering for everything after.

A dataset row can carry `title`, `status`, `description`. It can **never** carry `taskId` — the
id does not exist until something inserts a row into the application's database, and a JSON
cell in a Turso table cannot do that. Yet `taskId` is what `orchestrate` actually takes. So
between the data and the prompt there has to be a step that *runs code over the data*, and that
step is a resource with arguments. It is not a second way to express a dataset row; it is the
only available join between one and the prompt it is supposed to exercise:

```
dataset row            resource args         resource outputs        prompt slots
{ title, status }  →   seededTask(args)  →   { taskId, title }  →   orchestrate(taskId, taskInfo)
  data, syncable         code, per run         code + data            what runs
```

Two consequences worth stating plainly, because they are the argument for this ordering:

- **Arguments are what makes a dataset reach past the serializable boundary.** Without them a
  dataset can only fill slots that a JSON value could already fill, which is the small half of
  the problem. `specs/execution-inputs.md` §C's table has a "Can hold / anything, incl. a live
  handle" row on the resource side and "JSON only" on the dataset side; arguments are the door
  between the two columns, and it only opens one way.
- **The dataset work gets smaller, not bigger.** `ExecutionInput` already declares a `dataset`
  variant, and arguments are `ExecutionInput`s (§C). So "bind this column to a resource
  argument" needs no new binding surface at all — it is the same variant in a slot that already
  exists by then, matched by the same source-agnostic rules `execution-inputs.md` §D was
  deliberately written to be. Building datasets first would mean designing that surface twice.

The reverse check: does anything about arguments become *harder* to change once datasets exist?
Only the wire, and §C keeps arguments out of the URI precisely so that nothing downstream is
pinned by them.

**What this does not do is replace the helper.** `seededTask({ title: "Todo app", … })` keeps
working and keeps producing a resource — code-authored partial application is a normal thing to
write. The point is that the *unbound* dimension becomes reachable from data, not that the
bound form is taken away. See §L for why a first-class `preset:` field is not the answer.

## B. Arguments are entries in `inputs`

A resource's dependencies are declared as a map of things it takes. An argument is a thing it
takes. So the declaration is the map it already has, with a second kind of entry allowed in it:

```ts
/** One thing a resource takes: another resource, or a value validated by a schema. */
export type ResourceInput = Resource<any> | StandardSchemaV1;

export type ResourceInputs = Record<string, ResourceInput>;

export type ResolvedResourceInputs<N extends ResourceInputs> = {
  [K in keyof N]: N[K] extends Resource<infer T>
    ? T
    : N[K] extends StandardSchemaV1<unknown, infer O>
      ? O
      : never;
};
```

```ts
export const seededTask = resource({
  group: "Seeded Tasks",
  label: "Seeded task",
  inputs: {
    db,                                    // bound in code, by reference
    title: z.string(),                     // bound per run, by the panel or a dataset
    status: z.enum(["triaged", "open", "done"]),
    description: z.string().optional(),
  },
  outputs: { taskId: "Task ID", title: "Title", status: "Status", description: "Description" },
  create: async ({ db: { db, workspaceId }, title, status, description }) => {
    const { taskId } = await createTask(db, { workspaceId, title, status, description });
    return { value: { taskId, title, status, description } };
  },
});
```

**Arguments change `create`'s signature not at all.** Its first parameter is still spelled
`ResolvedResourceInputs<N>`; every resource written against today's API keeps compiling, and the
new kind of entry arrives already destructured beside the old kind. (§E does add a second
parameter, for the receipt — a different kind of thing, on purpose: see §L.) Five properties, in
order of weight:

- **Binding time is not `create`'s business.** An input is satisfied either by code (a reference to
  another resource) or per run (a validated value from the panel, a dataset column, or a recorded
  trace). Which one it was is the *declaration's* concern, and `create` reading `title` the same
  way it reads `db` is the point rather than a loss of information.
- **The split is per entry, which is strictly more robust than per parameter.** The loader already
  walks the `inputs` object, and the two kinds are structurally distinct at runtime — a resource
  carries `RESOURCE_TAG`, a schema carries `~standard` — so `isResource(v)` partitions the map with
  no checker involved at all. Nothing has to infer which half of a parameter list is which.
- **Name collisions become impossible by construction.** One namespace, one set of keys. A separate
  argument bag would have had to answer what `{ db }` in one and `{ db }` in the other means.
- **Validation comes free, and it is new.** A value typed into the panel or lifted out of a dataset
  row is checked before `create` runs, so a mistyped `status` fails as
  `Resource 'tasks.ts#seededTask': invalid value for 'status' — expected one of …` rather than as
  something incoherent inside `createTask` several frames down. The registry awaits
  `~standard.validate` (it may be async) on each schema-valued entry and reports issues against the
  parameter that produced them.
- **A schema is not introspectable, so types still come from the checker.** Standard Schema
  deliberately exposes only `validate` and inferred types — no field enumeration, no JSON Schema —
  so the `PropDefinition`s the panel renders come from `InferOutput` through the probe in §H, not
  from asking the schema what it contains. Reaching for a vendor's own `toJSONSchema()` where one
  exists is explicitly not done: it would make the panel's behaviour depend on which validation
  library an author happens to use.

Two consequences worth stating separately:

**Checker-less mode degrades better than it would have.** The parameter *names* are runtime data —
the schema-valued keys of `inputs` — so even with no checker the panel knows a resource takes three
parameters and what they are called, and can offer plain editors for them. Under a second
`create` parameter, a missing checker meant knowing nothing at all. Validation still runs, so a
value typed into an untyped editor is still checked before it reaches `create`.

**The dependency is types-only.** `@standard-schema/spec` ships an interface and no runtime code,
and is already present transitively (the `ai` peer dependency uses it). It becomes a direct
dependency so the core's own types can name it; authors bring whatever validator they already use.

Optionality comes from the schema (`z.string().optional()`), which is also where defaults belong
(`z.enum([…]).default("triaged")`) — a validator applies its own default during `validate`, so the
panel can leave a field empty and `create` still receives the value the author intended. That is
better than the previous shape, where a default could only live in `create`'s body where the panel
could never see it.

**Static resources still take no arguments.** `StaticResourceDefinition` has a `value` and neither
`inputs` nor `create`; there is nothing to validate against and nothing to run.

## C. Identity: arguments live in the reference, never in the URI

```ts
| {
    kind: "resource";
    uri: string;
    /** Values for the resource's declared arguments, by parameter name. */
    args?: Record<string, ExecutionInput>;
    /**
     * What this resource's `create()` produced. Recorded on every run; sent
     * back — only by a replay — so `create` can reconstruct rather than
     * re-mint. See §E.
     */
    receipt?: unknown;
  }
```

**The URI grammar does not change.** This is the same constraint `resource-hierarchy.md` §B held
for groups, and for the same reason with more force: a reference is persisted in `localStorage`
and recorded into traces, so folding arguments into `tasks.ts#seededTask(title=Todo%20app)`
would mean every stored selection is invalidated by an edit to a text field, and no past trace
could name a resource without also naming the run that used it.

| | grammar | changes when |
| --- | --- | --- |
| URI (identity) | `<module>#<export>[.<output>]` | the module moves, the export or output key is renamed |
| `args` (binding) | `Record<string, ExecutionInput>` | freely, per execution |

Three properties fall out of `args` being `ExecutionInput` rather than a new shape:

- **Recursion is free.** An argument may be a typed-in value, an object with some fields typed in
  and one filled by a resource, another resource (with its own arguments), or a dataset cell —
  because those are the four variants that already exist. No new resolution path, and
  `resolveExecutionInput` recurses into `args` with the code it already has for `object`.
- **It stays JSON-safe by construction**, which is what `execution-inputs.md` §F built the union
  for, so the whole binding round-trips through `localStorage` and into a trace unchanged.
- **The recipe is the cache key** (§D). A resolved argument may be a live handle that cannot be
  compared or hashed; the unresolved `ExecutionInput` that produced it is plain data and always
  can be.

## D. Server: the lease keys on resource **and** binding

`ResourceRegistry` memoizes by resource *object* within a lease — the property that makes
`taskA.id` and `taskA.info` one seeded task. With arguments the key has to widen by exactly one
term:

> A lease creates one instance per (**resource object**, **canonical argument key**). The key is
> the stable JSON encoding of `args` (object keys sorted, absent and `{}` both encoding to `""`),
> computed over the *unresolved* recipe.

That gives the three behaviours the panel needs, without a fourth concept:

| selection | instances created |
| --- | --- |
| `seededTask` for `taskId` and `seededTask.title` for `taskInfo`, same args | one |
| the same resource chosen twice with different args | two |
| a resource with no arguments, chosen anywhere | one — today's behaviour, unchanged |

The lease API grows one optional parameter and stays ignorant of `ExecutionInput`, which is the
seam `execution-inputs.md` §F drew on purpose ("a `uri` is provider-interpreted and always was"):

```ts
/** A resource reference's arguments, as the lease sees them. */
export interface ResourceBinding {
  /** Canonical key for these arguments — identity for memoization. */
  key: string;
  /** Resolves the arguments. Called at most once per (resource, key), lazily. */
  resolve(): Promise<Record<string, unknown>>;
  /** A past run's receipt, on a replay. Passed to `create`; never part of {@link key}. See §E. */
  receipt?: unknown;
}

acquire(uri: string, binding?: ResourceBinding): Promise<unknown>;
```

`resolveExecutionInput` builds the `ResourceBinding` — it is the layer that knows how to turn an
`ExecutionInput` into a value, and `resolve()` closes over the same lease, so a resource used
inside an argument memoizes with everything else in the run. What comes back is validated against
each parameter's schema (§B) before `create` sees it, and a failure names the resource and the
parameter — an argument bound to a dataset column is exactly where a type mismatch will show up
first, and it must not surface as a stack trace from inside someone's `createTask`. `resolve()` is a thunk rather than a
resolved object because arguments must not be evaluated for a binding that turns out to be
memoized already, and because a failed `create` must not have side effects from arguments no one
asked for.

Four smaller rules:

- **Cycles are detected on the resource object, ignoring the key.** `A(x) → B → A(y)` is
  rejected even though the keys differ. It is more aggressive than strictly necessary and that is
  the right side to err on: the legitimate case (a resource that recursively seeds itself with
  different arguments) does not exist, and unlike today's code-authored `inputs` cycles, an
  argument cycle can be assembled by a user in the panel and must produce a legible error rather
  than a stack overflow. The panel also declines to offer a resource as an input to itself (§I).
- **Scope.** The existing rule — a `server`-scoped resource must not depend on a `run`-scoped one
  — extends to arguments unchanged, but moves from load time to resolution time, because the
  argument is not in the code. The error names both URIs, as the `inputs` version does.
- **A `server`-scoped resource may not take arguments.** Keying the server map on (resource, key)
  is the coherent alternative — it is a memoized factory — but it makes an unbounded set of
  long-lived instances, disposed only at `invalidate()`, out of whatever someone types into a text
  field, and nothing expensive enough to want server scope is parameterized today. Refused in two
  places: the provider reports such a resource through the `ResourceInfo.error` field that already
  exists for a broken module, so it reads as misconfigured in the panel rather than missing; and
  the registry throws if `args` reach a `server`-scoped resource anyway. The refusal is reversible
  — lifting it widens the accepted set, invalidating no stored selection and no trace — and the
  leak is not.
- **Receipts are keyed by the same identity the memo is.** `lease.receipts()` returns
  `Record<uri, unknown>` today, which collapses two differently-bound instances of one resource
  into one entry. The key becomes `uri` when a resource takes no arguments (so today's entries are
  byte-identical) and `uri@<argument key>` when it does. Worth doing in step 1 even though §I's
  one-binding-per-URI rule means the panel cannot produce a collision: a dataset fan-out can, and
  `specs/resource-observation.md` hangs a per-run timeline off this same key.

## E. Receipts flow back into `create`

A receipt is what a run's `create()` wrote down about what it produced. Today it is write-only —
recorded (or rather, meant to be; see §K) so a trace can *display* `tsk_abc123`. Make it a
**round trip** instead, and replay stops being approximate:

```ts
export interface ResourceInstance<T, R = unknown> {
  value: T;
  /** What this instance produced, handed back to `create` on a replay. */
  receipt?: R;
  dispose?: () => void | Promise<void>;
}

// on DynamicResourceDefinition<T, N, R>:
create(
  inputs: ResolvedResourceInputs<N>,
  receipt?: R,
): ResourceInstance<T, R> | Promise<ResourceInstance<T, R>>;
```

```ts
create: async ({ db: { db, workspaceId }, ...task }, receipt) => {
  // Reuse the id the original run minted, so a replay produces the same row.
  const { taskId } = await createTask(db, { workspaceId, ...task, taskId: receipt?.taskId });
  return { value: { taskId, ...task }, receipt: { taskId } };
},
```

The contract, stated so an author knows what is being asked of them:

> Given the same `inputs` and the same `receipt`, `create` should produce an equivalent value —
> and, where the world allows it, the *same* one. The receipt is the resource's own note about
> what it made last time; handing it back is what lets a replay reconstruct rather than re-mint.

**Why identity is the thing worth reconstructing: a replay exists to be compared.** Nobody replays
a trace to watch it happen again; they replay it because the prompt changed and the question is
what moved. If the replay mints `tsk_xyz789` where the original had `tsk_abc123`, every span
differs — every tool input, every tool result, most of the model's text — and a diff of the two
traces is noise with the answer buried in it. Hold the ids and the diff shows only behaviour. The
same property is what lets an annotation or an assertion that names a row survive the run it was
written against.

Four rules:

- **Advisory, never enforced.** The core hands the receipt over; whether to honour it is a decision
  inside `create`, and nothing can check that it was. A resource that ignores its receipt is simply
  back to today's behaviour, which is a fine place to be for anything whose identity nobody cares
  about.
- **The receipt does not widen the memo key.** Receipts are recorded per (uri, argument key) per
  §D, so there is exactly one per key by construction; the receipt rides *on* the binding rather
  than becoming part of it. Two references to one instance still resolve to one `create`.
- **Only a replay sends one.** A fresh run sends no receipts, so `create` sees `undefined` and
  mints. This changes `ExecutionInput.receipt`'s documented contract — "Recorded, never sent by the
  panel" becomes *recorded on every run, sent back only by a replay* — and it is the only place the
  panel and a replay differ on the wire.
- **A receipt is data from a past run, and an old one.** It was written by an older revision of the
  author's own code and has been sitting in a database since; `create` should read it defensively
  rather than trust its shape. This is the same class of problem `parameterDefinitions` already
  records for prompt signatures, and gets the same treatment: write the shape down, do not pretend
  it cannot drift. See §Q.5.

**One shipped behaviour has to be reverted for this to work.** `lease.acquire` currently records,
for an *output* source, the output's own value when it is plain JSON, falling back to the
instance's receipt:

```ts
const receipt = outputPath.length === 0 ? instance.receipt
  : isPlainSerializable(read.value) ? read.value : instance.receipt;
```

That was right when a receipt was only ever displayed — it is exactly what let a trace say
`tsk_abc123` for `seededTask.taskId` without the author writing a receipt at all. It is wrong the
moment a receipt is fed back to `create`: replaying that reference would hand the string
`"tsk_abc123"` to a `create` expecting `{ taskId }`. A root reference and an output reference name
the **same instance**, so both record that instance's receipt, full stop. The display nicety is not
lost — an author who wants the id in the trace puts it in the receipt, which for `seededTask` is
precisely what the receipt already is.

## F. `reset`: what makes reusing a receipt safe

Reusing `tsk_abc123` only works if the row from last time is gone. So the receipt round trip has a
precondition: a resource whose identity is reconstructible wants a database that starts each run
clean. Standing up a fresh Miniflare per run is what `scope: 'server'` exists to avoid; truncating
every table is not expensive.

```ts
export interface ResourceInstance<T, R = unknown> {
  value: T;
  receipt?: R;
  dispose?: () => void | Promise<void>;
  /**
   * Returns this instance to its between-runs state. Called on a server-scoped
   * instance before the first run that uses it; never on a run-scoped one.
   */
  reset?: () => void | Promise<void>;
}
```

- **Before a run, not after**, and lazily — on the first `acquire` of that instance within a lease,
  which is also the only place the registry can see a run boundary at all. Resetting afterwards
  would leave the database clean at rest and destroy the thing you most want to look at when a run
  goes wrong; resetting before means the last run's wreckage is still sitting there to poke at.
- **Ordering falls out of the dependency graph.** Anything that seeds rows takes the database as an
  input, so its `create` runs after the reset by construction. Nothing new has to sequence them.
- **It serializes the runs that share it**, and this is the part that must not be discovered later.
  Server-scoped instances are shared across concurrent runs today, and the playground dispatches a
  run without waiting for the previous one — so an unserialized `reset` would wipe an in-flight
  run's data. A lease holds a resettable instance for its lifetime and a second lease's `acquire`
  waits. The consequence reaches further than it looks: **a dataset fan-out over 50 rows runs
  serially for exactly the resources that declare `reset`**, and in parallel for everything else,
  which is a property the dataset spec has to know rather than discover in a flaky eval. Resettable
  instances are acquired in sorted-URI order so two runs cannot take two locks in opposite orders.
- **Run-scoped resources ignore it** — they are created fresh per run, so a `reset` on one is a
  misunderstanding worth a load-time warning rather than a silent no-op.

**Without a reset, a receipt-honouring `create` fails loudly**, which is the right failure: it
inserts a row whose id is already taken and the run stops with a unique-constraint violation
naming it. The core cannot detect the combination in advance — whether a receipt is honoured is
invisible inside `create` — so this is guidance rather than a check, and the failure being
immediate and specific is what makes guidance sufficient.

**Why not compose it out of what exists?** It nearly works today: a run-scoped resource that takes
the server-scoped handle as an input, truncates in `create`, and returns the same handle gets
reset-before-run semantics with no new API, memoized once per run. Two things stop that from being
the answer, and the second is decisive:

1. The core cannot tell that it happened, so it cannot serialize the runs that need it.
2. The picker offers both. The raw `db` and the truncating wrapper produce the same type, so both
   are offered for every `Db` slot, and choosing the plainly-named one silently skips the reset. A
   capability this easy to bypass by picking the wrong entry in a menu belongs on the instance, not
   beside it.

## G. Wire: parameters on `ResourceInfo`, matches on `PromptInputSources`

```ts
export interface ResourceInfo {
  uri: string; label: string; scope: ResourceScope; /* … */

  /**
   * The resource's declared arguments, as slots for the panel to render.
   * Absent when the resource takes none. Present with an unresolved type when
   * the requirement is known but its shape is not.
   */
  parameters?: PropDefinition[];
}

export interface PromptInputSources {
  resources: ResourceInfo[];
  functionSlots: Record<string, string[]>;
  executeSlots: Record<string, string[]>;
  /** Resource URI → (argument slot path → URIs of sources that can fill it). */
  resourceSlots?: Record<string, Record<string, string[]>>;
}
```

`parameters` is `PropDefinition[]` — the same shape `functionParameters` and `executeParameters`
use — so the panel renders an argument with `ItemEditor` and matches sources to it with
`collectInputSlots` + `matchSourcesToSlots`, with no branch anywhere that asks whether a slot
belongs to a prompt or to a resource. One entry per schema-valued key of `inputs`, in declaration
order; a resource whose `inputs` holds only resources reports none.

**Degradation is partial rather than total**, per §B: where no checker is available (the documented
`MemoryFileProvider` mode) the schema-valued keys are still enumerable at runtime, so `parameters`
carries the right names with unresolved types instead of being absent. The panel offers a plain
editor per parameter and validation catches what the type would have.

**`parameters`, not `inputs`, is the right name on the wire** even though these come from the
resource's `inputs` map: the wire field carries only the schema-valued subset, because a
resource-valued entry is bound in code and is not the panel's to fill. Naming it `inputs` would
promise the whole map and deliver half of it. The prompt side already spells this distinction the
same way — `functionParameters` declares, `functionInputs` supply — so a resource's `parameters`
being filled by `args` reads as the third instance of one pattern rather than a new one.

`resourceSlots` is separate from `functionSlots` / `executeSlots` and keyed by URI rather than
folded into the slot path, because an argument slot is a property of the *resource*, not of the
prompt: the same resource offers the same arguments in every prompt that can see it, and a path
like `taskId.@args.title` would put a second grammar on the wire that only one component reads.

## H. Provider: one more probe, one more slot root

Both halves already exist; each needs one expression written.

**The type.** The registry already knows *which* keys are parameters — it partitioned `inputs` at
load time with `isResource` — so the probe only has to name each one's type. Written inline rather
than through an imported `InferOutput` alias, so the injected context needs no import of its own,
and defensively, so a key that turns out not to be a schema resolves to `never` rather than failing
to compile:

```ts
`${exported}["inputs"][${JSON.stringify(key)}] extends { "~standard": { types?: { output: infer O } } } ? O : never`
```

Fed through `resolveTypeProbes` → `buildPropTypeFromType`, that yields one `PropDefinition` per
parameter for §G. One probe per parameter rather than one per resource — slightly more probes,
and in exchange each parameter's optionality and description come out of its own resolution
instead of being read back off an enclosing object type. Batched into the program build the
provider already does for prompts; a parameter's type does not depend on the prompt, so each is
resolved once and reused across every prompt in scope.

**The matches.** `resolveSlotMatches` already accepts `extraSlots` (slot name → type expression)
for exactly this reason — execute parameters, whose types are nowhere in a signature. A
resource's arguments become extra roots under a namespaced key, and the results are
demultiplexed back out into `resourceSlots`. Two rules on top:

- **A resource is not offered as an input to its own arguments**, nor is any resource that
  transitively depends on it. Cheap to compute from the dependency graph, and it turns §D's cycle error
  from something a user can walk into in the picker into something they cannot.
- **Matching a resource's *value* to a prompt slot stays argument-independent.** The produced
  type is read off `create`'s declaration, not off a binding, so `seededTask.taskId` is offered
  on every `TaskId` slot regardless of what its arguments are set to. This keeps matching static
  (it must run before any binding exists) and keeps the N×M cost exactly where
  `resource-hierarchy.md` §O.2 left it — arguments add slots to fill, not sources to test.

## I. UI: the arguments appear under the chip

```
taskId                                   [ ⋯ ]
┌──────────────────────────────────────────┐
│ ◆ Seeded task        created for each run│
│   title        [ Todo app            ]   │
│   status       [ triaged             ]   │
│   description  [ Build a todo list…  ]   │
└──────────────────────────────────────────┘

taskInfo                                 [ ⋯ ]
┌──────────────────────────────────────────┐
│ ◆ Seeded task — Task Info                │
│   arguments shared with `taskId` above   │
└──────────────────────────────────────────┘
```

`SourceRow` already renders the chip and owns the picker, so the argument form is a block beneath
the chip, rendered by the same `ExecutionInputEditor` that renders a prompt parameter — arguments
are `PropDefinition`s with matched sources, which is the exact input that component takes.
Nesting bottoms out at a depth cap of 3 in the panel (a resource whose argument is a resource
whose argument is a resource); §D's cycle check is the backstop for anything past it.

**One binding per resource per prompt.** The wire format expresses arguments per *reference* (§C),
so two references to one resource with different arguments is representable and resolves to two
instances. The panel deliberately does not offer that in v1: arguments are held once per URI,
every selection of that URI shows the same values, and editing them anywhere edits them
everywhere. Two reasons, in order:

- It keeps the invariant users already rely on — picking `seededTask.taskId` for one slot and
  `seededTask.title` for another seeds **one** task. Per-selection arguments would make that
  depend on whether two forms happen to agree character-for-character, which is not a thing
  anyone can see.
- A second instance of the same resource in one run has no motivating case yet (odin's parent and
  child tasks come out of a single `create`), and the wire is already shaped to allow it when one
  appears — a named-instance UI later changes no format. See §Q.2.

The first selection in panel order renders the expanded form; later ones show the chip and a
note. Panel order, not selection order, so the form does not jump when a slot above is changed.

**Combined mode needs no changes**, again: `CombinedInputEditor` intersects matches across member
paths and hands the result to `SourceRow`, and a chip with a form under it is still a chip.

## J. Client state

`Selections = Record<string, SlotSelection>` stays as it is. Arguments are a sibling map at the
panel level, because §I holds them per URI rather than per slot:

```ts
/** Argument editor state, shared by every selection of a resource. */
type ResourceArgs = Record<string /* resource uri */, Selections>;
```

- `toExecutionInput` stamps `args` onto every `{ kind: "resource" }` node it emits, from the map.
  The fold is otherwise unchanged, and a resource with no arguments emits no `args` key — which
  is what keeps an existing stored selection byte-identical.
- `fromExecutionInput` reads `args` off any resource node it walks and merges it into the map;
  identical by construction, and last-writer-wins is harmless where they are not (a trace
  recorded by a future per-instance UI, replayed into this one).
- Persistence is unchanged in shape: `localStorage` already stores `Record<name, ExecutionInput>`,
  and the arguments now ride inside those inputs rather than in a second key.

## K. Traces and the loop this closes

Recording `args` in the trace's inputs makes replay of a resource meaningfully exact for the
first time. `execution-inputs.md` §H is candid that a run-scoped resource replays as "today's
code, run again" with nothing said about what it was given; with arguments recorded, replay runs
today's code *with the same inputs*, and the receipt still says what the original run produced.
That is strictly more than the helper-per-task shape could offer, where the arguments were
compiled into the resource's identity and a rename lost them.

It also completes the path this proposal exists to open:

```
production trace  →  the serializable half of its inputs  →  dataset row
                                                               ↓
                                        local run  ←  seededTask(args)  ←  bound to the row
```

Step 1 is `trace-workshopping.md`'s territory and step 3 is the dataset spec's; this proposal is
the middle arrow, and it is the one that has to exist before either end is worth building.

**Receipts do not currently reach the trace at all.** `ResolvedInputs.receipts` is computed by
`FilePromptProvider.resolveInputs` from `lease.receipts()` and then dropped: `api-routes.ts`
destructures `functionParams` and `executeValues` off the resolution and nothing reads the third
field, so `ExecutionInput.receipt` — declared, documented, and the thing that is supposed to make
a past run legible — is written by no one. Stamping receipts onto the recorded inputs before
`execute` is a handful of lines and belongs in step 2, because every claim this section makes is
false until it happens.

**What replay then costs.** `execution-inputs.md` §H treats replay as a later project gated on
prompt and dataset versioning. Most of that gate is about the *prompt* having changed, which is
the thing a replay is usually trying to observe. For the resource half, everything needed is in
this proposal:

1. Receipts are recorded, keyed by (uri, argument key) — §D, and the wiring gap above.
2. The recorded resource node is `{ uri, args, receipt }` — a self-describing triple of *what went
   in*, *what code ran*, and *what came out*.
3. `/execute` accepts receipts on the way in and the lease passes them to `create` — §E.

Then "replay this trace" is: take the recorded `functionInputs` and `executeInputs` verbatim, POST
them, and let §E's contract do the rest. No new format, no new resolution path, and the
`parameterDefinitions` already recorded beside them are what tells the panel when the prompt's
signature has moved out from under the recording. The button is the only missing piece, and it is
a button.

That same triple is what makes a resource's run capturable back into a dataset row — the direction
`specs/resource-observation.md` runs in, now shelved.

## L. Alternatives considered

**`preset:` — a named, code-authored argument binding on the resource.** One line instead of a
helper function, and it renders as a submenu entry for free. Rejected on `execution-inputs.md`
§C: it is authored data in code, which is the thing datasets exist to replace, and shipping it
would mean deprecating it roughly when they land. The helper function stays available for anyone
who wants the same effect today, and costs the core nothing.

**Arguments in the URI.** Makes a bound resource a first-class selectable thing, and makes
memoization fall out of the existing by-URI map. Rejected on §C: identity that changes when a
text field changes invalidates stored selections and makes traces unreplayable, which is the
exact failure `resource-hierarchy.md` §B refused for a much cheaper reason.

**A bespoke runtime argument schema** (`args: { title: { type: "string", label: "Title" } }`,
mirroring `outputs`). Buys labels, ordering, and full introspection with no checker. Rejected
because Standard Schema is the same idea with an ecosystem behind it: authors already have a
validator, the AI SDK already speaks the interface, and a bespoke one would be a third type
vocabulary beside `PropType` and TypeScript itself. If argument *labels* or ordering turn out to be
wanted, that is a display-metadata map beside `inputs` — the same relationship `outputs` has to the
produced type — and it changes nothing here.

**Vendor introspection** (`z.toJSONSchema()` where the schema turns out to be zod). Would give
`PropDefinition`s with no checker at all. Rejected: it makes the panel's behaviour depend on which
validation library an author picked, and the checker path has to exist anyway for the resources
that have no schemas.

**Arguments as a second parameter to `create`** — `create(inputs, args)`, with the argument type
read off `Parameters<X["create"]>[1]`. This was the earlier draft of §B and it lost on three
counts, all of which only became visible once the alternative was written down: the parameter
names are invisible without a checker (so the checker-less mode degrades to knowing nothing rather
than to knowing the names), two namespaces make `{ db }` in each of them a question with no good
answer, and nothing in it validates. Its one advantage — you can tell at `create`'s call site which
half is which — is an advantage over a distinction that should not matter to `create`.

**This is not an argument against §E's receipt parameter**, and the difference is worth naming
because the two look alike from a distance. Every objection above is about a *named bag of values a
user supplies*: names that must be enumerable, a namespace that must not collide, values that must
be validated. A receipt is one opaque value, produced by the author's own `create` and handed back
to it — nothing to enumerate, nothing to collide with, and nobody to validate against, because it
never passes through a human. It is not an input at all; it is a continuation of the last run, and
a parameter is the honest place for it.

**Letting the panel rebind a resource-valued `inputs` entry.** Genuinely wanted eventually, and §B's
one-map framing is what makes it expressible later. Out of scope: see §M.

**Skipping arguments: let dataset columns fill prompt slots directly.** Covered in §A — it cannot
produce a `taskId`, and the prompt takes a `taskId`.

## M. Non-goals

- Rebinding a *resource-valued* `inputs` entry from the panel (swapping the real `db` for a
  throwaway one). §B makes the shape obvious now — the entry would have to declare itself
  swappable, since a live handle has no schema to validate against — but nothing in the dataset
  path needs it, and today's `inputs` being a static guarantee is worth keeping until something
  does.
- Two differently-bound instances of one resource in a single run (representable, not offered).
- Argument-dependent produced types (`seededTask({status: "done"})` narrowing its value type).
  Matching is static by §H and stays that way.
- Argument defaults expressed anywhere but in the schema (§B), which is the only place the
  panel can see them.
- Observing a resource over the life of a run — before/after state, per-step snapshots.
  `specs/resource-observation.md` is **shelved**; §D's receipt keying is what it would build on.
- The replay *button*, and everything `execution-inputs.md` §H says about prompt versioning. §K
  narrows what replay costs; it does not ship it.
- Datasets. This proposal's job is to be the thing they plug into.

## N. Phasing

1. **Schemas in `inputs`, server-side.** `ResourceInput`, the mapped `ResolvedResourceInputs`, the load-time
   partition, validation before `create`, `ResourceBinding`, the lease's (resource, key)
   memoization, canonical key encoding, static-resource rejection, argument cycle and scope
   errors. Testable end to end against a hand-written `ExecutionInput`
   before any UI or checker work exists.
2. **`ExecutionInput.args`** through `resolveExecutionInput` / `resolveExecutionInputs` /
   `FilePromptProvider.resolveInputs`, and recorded into traces — including stamping
   `lease.receipts()` onto the recorded inputs, which nothing does today (§K).
3. **The receipt round trip.** `R` on the definition types, `create`'s second parameter, receipts
   accepted on the way in and carried on the binding, and the output-source receipt rule reverted
   (§E). Independent of the panel: testable by POSTing a recorded input back.
4. **`reset`.** The hook, reset-on-first-acquire, the per-instance lock and sorted acquire order,
   the load-time warning for a run-scoped `reset` (§F). What makes step 3 safe in practice.
5. **The probe.** `parameters` on `ResourceInfo`, the defensive type expression, the unresolved
   placeholder for the checker-less mode.
6. **`resourceSlots`.** Arguments as extra slot roots in `resolveSlotMatches`, self-exclusion.
7. **The panel.** `ResourceArgs` state, the form under the chip, the shared-binding note, the
   depth cap, persistence and restore.
8. *(later, separate)* Datasets fill the fourth variant, in argument slots and prompt slots alike.

Steps 1–2 are enough to convert `.evalution/playground/tasks.ts` to a single resource and drive
it from a hand-written request; 3–4 make a recorded run reproducible without any UI at all; 5–7
are what the playground needs to drive it by hand.

## O. Files

- `package.json` — `@standard-schema/spec` as a direct dependency (types only; already present
  transitively via `ai`).
- `src/prompt/playground/resource.ts` — `ResourceInput`, `ResourceInputs`, the mapped
  `ResolvedResourceInputs`; the `R` type parameter on `ResourceInstance` /
  `DynamicResourceDefinition` / `ResourceDefinition` / `resource()`; `create`'s receipt parameter;
  `reset` on the instance; doc comments for `npm run docs`.
- `src/prompt/playground/resource-registry.ts` — partitioning `inputs` into dependencies and
  parameters, schema validation before `create`, `ResourceBinding`, `acquire(uri, binding)`,
  (resource, key) memoization in `instantiate` / `create`, argument-aware cycle and scope errors,
  static-resource rejection; the receipt handed to `create` and the output-source receipt rule
  reverted (§E); `reset` on first acquire, the per-instance lock, sorted acquire order (§F).
- `src/prompt/execution-inputs.ts` — `args` resolution and the `ResourceBinding` it builds;
  `ResourceResolver`'s signature.
- `src/server/api-routes.ts` — stamp `resolved.receipts` onto the inputs recorded with the run,
  and accept receipts arriving on a replay rather than stripping them.
- `src/shared/types.ts` — `ExecutionInput`'s `resource` variant gains `args`; `ResourceInfo.parameters`;
  `PromptInputSources.resourceSlots`.
- `src/prompt/file/file-prompt-provider.ts` — the argument probe, `resourceSlots` matching,
  self-exclusion from the dependency graph.
- `src/prompt/file/ts/ts-prompt-file-type.ts` — a probe evaluated against a playground module
  rather than a prompt file, if `withInjectedTypes` cannot be pointed at one as it stands.
- `src/client/components/PlaygroundExecution.tsx` — `ResourceArgs` state, persistence, restore.
- `src/client/components/execution-input-state.ts` — stamping `args` in `toExecutionInput`,
  reading them back in `fromExecutionInput`.
- `src/client/components/SourceRow.tsx` — the form under the chip, the shared-binding note.
- `src/client/components/ExecutionInputEditor.tsx` — rendering a resource's arguments, depth cap.
- `src/client/styles.css` — the argument block.
- `src/client/components/__fixtures__/executionFixtures.ts` — a parameterized fixture.
- `docs/` — the resource authoring guide gains arguments.

## P. Verification

- **Unit, registry (`vitest`, `MemoryFileProvider`):** two acquisitions of one resource with
  equal arguments run `create` once and dispose once; with different arguments, twice and twice;
  argument key encoding is order-insensitive over object keys and treats absent and `{}` alike;
  receipts are keyed `uri` with no arguments and `uri@<key>` with them; a `server`-scoped resource
  declaring arguments is reported with an `error` and throws if `args` reach it anyway;
  `create` receives resolved dependencies and validated arguments in one object; a value failing
  its schema fails the run with a message naming the resource and the parameter, before `create`
  runs; a schema's default is applied when the panel sends nothing; an argument naming the
  resource itself fails with a cycle error naming both; a `server`-scoped resource given a
  `run`-scoped resource as an argument fails with the lifetime error; arguments passed to a
  static resource fail with a message naming the URI; arguments are not resolved at all for a
  binding that hits the memo.
- **Unit, execution inputs:** `args` round-trip through `resolveExecutionInput`, including an
  argument that is itself a resource and one that is an `object` with a resource in one field; a
  resource used both as an argument and as a prompt input creates one instance per run.
- **Unit, receipts (§E):** `create` receives `undefined` on a fresh run and the recorded receipt on
  a replay; the receipt does not change the memo key, so one instance still backs two references
  whose receipts are equal; an *output* reference records the instance's receipt, not the output's
  own value (the reverted rule — the regression that would silently feed a string where an object
  is expected); a resource that ignores its receipt still runs, mints, and records the new one.
- **Unit, `reset` (§F):** called once per lease, before `create`, on a server-scoped instance, and
  not at all on a run-scoped one; a second lease's `acquire` of a resettable instance waits for the
  first to release; two leases acquiring two resettable instances in opposite request order still
  take them in sorted-URI order and do not deadlock; a run-scoped `reset` warns at load.
- **End to end, replay:** run `seededTask` once, take the recorded inputs verbatim, POST them back,
  and see the same `taskId` in the second trace — with the first run's row gone, not duplicated.
- **Unit, provider:** a resource whose `inputs` holds only resources reports no `parameters`; a
  mixed one reports one `PropDefinition` per schema-valued key, in declaration order, with
  optionality carried through; with no checker, `parameters` carries the right names with
  unresolved types rather than being absent; `resourceSlots` offers a `TaskId` resource for a
  `z.string()`-typed argument it is assignable to, and does not offer the resource itself.
- **Unit, client state:** `toExecutionInput` stamps shared arguments onto every reference to a
  URI; a resource with no arguments emits an input byte-identical to today's;
  `fromExecutionInput` restores the argument map; a stored selection made before this change
  restores unchanged (the back-compat regression that would catch arguments leaking into identity).
- **Playwright (`*.pw.tsx`):** choosing a parameterized resource reveals its argument form;
  typing into it and choosing the same resource for a second slot shows the shared-binding note
  with the same values; the form round-trips through `localStorage`; a resource with no arguments
  shows no form; the argument form is not offered the resource it belongs to.
- **End to end:** convert `.evalution/playground/tasks.ts` to one `seededTask` resource, open
  `odin#orchestrate`, fill `title` / `status` / `description`, pick `Task ID` for `taskId` and
  `Task Info` for `taskInfo`, Run, and see **one** task seeded with those values backing both.

## Q. Open questions

1. ~~*Unbounded memoization of a parameterized `server`-scoped resource.*~~ **Decided: refused**
   (§D). A `server`-scoped resource may not take arguments. Revisit only if something genuinely
   expensive turns out to want them; the fix then is an LRU with disposal on eviction, not an
   unbounded map.
2. *Is one binding per URI per prompt too strict?* §I's case for it is the memoization invariant,
   and the wire already allows more. The shape that would relax it is named instances
   ("Seeded task #2"), which is a picker change and a `ResourceArgs` key change, nothing deeper.
   Worth revisiting the first time a prompt genuinely takes two of the same thing.
3. *Where does the argument probe get evaluated?* `withInjectedTypes` takes a `filePath` +
   `promptName` today because every existing probe is about a prompt. A resource's argument type
   is prompt-independent, so evaluating it in an arbitrary prompt's file works but reads wrong and
   ties the result's lifetime to that prompt. Cleanest is an overload that accepts a module path
   and no prompt; confirm the program build tolerates it before assuming.
4. *Does `R` infer without an annotation?* It appears in two positions of the same signature —
   `create`'s second parameter and the returned `ResourceInstance<T, R>` — which is exactly the
   shape that makes TypeScript pick a candidate from one site and check the other against it. An
   author who annotates the parameter (`(inputs, receipt?: { taskId: TaskId })`) is unambiguous and
   should be the documented idiom; inference from the return alone probably also works, and two
   *disagreeing* sites should be an error, which is the behaviour we want. Verify early in step 3
   before the doc comment promises either.
5. *Does a receipt's shape need to be recorded beside it?* A receipt read back a month later was
   written by code that has since changed, and §E asks `create` to be defensive without giving it
   anything to be defensive *with*. The cheap move is what the prompt side already does — record a
   shape snapshot next to the value — and the cheaper one is to say a receipt is the author's
   problem, which it honestly is. Decide once something has actually drifted.
6. *Should `reset` be required of a resource that honours receipts?* §F argues the failure is loud
   enough that guidance suffices, and the core cannot detect the combination anyway. If loud turns
   out to mean "loud on the tenth replay, in CI", the fallback is a declared flag on the resource
   rather than an inference.
7. *Does the mapped `ResolvedResourceInputs` infer cleanly?* Same question `resource-hierarchy.md` §J.1
   asked of `keyof T & string`, in the same object literal: `const N` now holds a union of two
   unrelated shapes, `create`'s parameter is a mapped type over it, and `T` is inferred from that
   same `create`'s return. The conditional itself is unambiguous — a `Resource` and a schema share
   no members — but the *ordering* (N from the literal, then `ResolvedResourceInputs<N>` into `create`'s
   parameter, then T out of its return) is where surprises live. Verify against the real odin
   module early in step 1; the fallback is an explicit type argument, as it is today.
8. *Do arguments want to be echoed as outputs automatically?* `seededTask` declares
   `outputs: { title, … }` and `create` returns `{ taskId, ...args }` — the arguments come straight
   back out, so that `taskInfo` can be filled from the same resource. It is mechanical enough to
   generate, and generating it would be one less thing to keep in sync. Left explicit for now
   because `resource-hierarchy.md` §A is emphatic that exposure is the author's judgement, and an
   argument is not automatically a useful output.
