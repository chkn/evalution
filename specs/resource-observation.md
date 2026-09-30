# Proposal: Resource observation — receipts over time, and capture back out

> **Status: SHELVED (2026-09-14).** `observe()` and everything built on it are parked — not
> rejected, and nothing here is known to be wrong. Two pieces moved out and are live:
> **`reset` is now `specs/resource-arguments.md` §F** (it turned out to be a precondition for
> replaying a receipt, not a way to keep snapshots small), and the receipt keying this document
> depends on is that spec's §D. What remains parked is the per-run *timeline*: `observe()`, the
> observation points, the sink that collects them, and the `capture` direction in §G–§H, which is
> blocked on datasets regardless. Read it as a design record, not a plan.
>
> **Update (2026-09-25):** `specs/evals.md` runs checks inside the run's lease, against live
> resources, so offline evals need none of this (see its §K). §A's premise — state capture as a
> `ResourceInstance` hook — also can't serve *online* evals, because production has no resources;
> if online evals return, capture belongs in app code shipped with the app.

## Context

A resource's receipt today is **one value, produced once, at create time**:

```ts
create: async ({ db }) => {
  const { taskId } = await createTask(db, { … });
  return { value: { taskId, … }, receipt: taskId };   // ← and that is the whole story
}
```

`specs/execution-inputs.md` §H introduced it to answer one narrow question — *what did that past
run actually use?* — so that a trace could say `tsk_abc123` even though replaying would mint a new
id. That is all it does, and it does not currently do even that: `lease.receipts()` is computed by
`FilePromptProvider.resolveInputs`, returned as `ResolvedInputs.receipts`, and then dropped on the
floor by `api-routes.ts`, which destructures `functionParams` and `executeValues` and ignores the
third field. Fixing that wiring is step 1 here and step 2 of `resource-arguments.md`.

Two asks that the one-value shape cannot carry:

1. **The overall effect of a run.** A `db` resource should be able to record the database's state
   before and after, so the combined effect of every tool call is visible in the trace and an eval
   can assert on it. A receipt computed at create time has no "after" — the interesting half of
   that pair does not exist yet when the receipt is written.
2. **The state at each step.** The same resource should be able to amend its record each time it
   is used, so the trace shows the database as it stood at every step rather than only at the ends.

And one that runs the other way:

3. **A runtime trace should generate a recipe that reproduces it locally** — which needs to know
   which database records the trace depended on, so they can be seeded.

(3) is mostly the dataset spec's job. It is in this document because it is the reason (1) and (2)
should be built a particular way: a rich enough record of what a resource did **is** the seed for
a dataset row, and if receipts are designed only for display that equivalence is lost.

---

## A. One hook, called at several moments

The temptation is three fields — `receipt`, `before`, `after` — or a mutable receipt the resource
amends in place. Both are worse than the obvious alternative: **one function that reports the
state now**, called whenever the run reaches a moment worth recording.

```ts
export interface ResourceInstance<T> {
  value: T;
  dispose?: () => void | Promise<void>;
  /** What this instance *is* — an identity summary, written once. */
  receipt?: unknown;
  /**
   * What the world looks like *now*. Called at each observation point (§B);
   * each call appends a sample to this instance's timeline for the run.
   */
  observe?: () => unknown | Promise<unknown>;
}
```

- **`receipt` and `observe` are not redundant.** *(Superseded in part: `receipt` is no longer
  write-only — it is handed back to `create` on a replay, and carries a type parameter. See
  `specs/resource-arguments.md` §E.)* `receipt` answers "which instance was this"
  (`tsk_abc123`) and is what a chip and a replay view show. `observe()` answers "what did the world
  look like", and there are many of those per run. Keeping them separate is what stops the chip
  from having to render a database.
- **Before, after, and each step are the same function at different moments.** The first call
  happens immediately after `create` settles — that is the "before", since nothing has run yet —
  and the last at teardown, which is the "after". Everything in between is §B. The author writes
  one query and gets all three, and nothing in the core has to know which is which.
- **Samples append; they never mutate.** A trace is append-only and the UI wants per-step state, so
  "amend the receipt" is spelled as a timeline whose last entry is the current state. Diffing is a
  display and scoring concern (§D), not a storage one.
- **Timelines are keyed by (uri, argument key)**, the identity `resource-arguments.md` §D gives the
  memo and the receipt map. Two differently-bound instances of one resource have two timelines;
  one instance shared across two slots has one, which is the same invariant the lease already
  enforces for `create`.

## B. When is "each time it is used"?

Nothing in the core can see a tool calling a method on a `db` handle — the value is handed over and
used directly, which is the entire point of a resource. So "used" has to be approximated by
something observable, and the trace is already the log of observable moments:

> **An observation point is the end of a `TOOL` span in the run's trace, plus once after `create`
> and once at teardown.**

That is a deliberate under-approximation, and it is the right one:

- **Tool spans are where state changes come from.** An LLM span's completion cannot have touched the
  database; snapshotting there would multiply cost and storage for samples identical to their
  neighbours.
- **It composes with the run, not with the SDK.** Any ingestor that produces `TOOL` spans gets this
  for free — native AI SDK telemetry, OTel, or OTLP from outside the process — because the trigger
  is a span, not an SDK callback.
- **It is honest about what it is.** A sample is labelled "state after `create_task`", not "state
  at the moment the resource was touched", because the second is not knowable from here.

If an author needs true per-access sampling, the answer is not a finer trigger but their own
instrumentation: they already control what `create` returns, so wrapping the handle in a proxy is
theirs to write. What they would additionally need is a way to *emit* a sample, which is a
`record(sample)` callback passed into `create` — a small, additive extension reserved in §J.3 and
deliberately not built now.

## C. Plumbing: a sink decorator and one callback

`CostFetchingTraceSink` is the precedent and the shape to copy: a `TraceSink` that enriches spans
on their way through and fans them out to its own downstream sinks, wired once in
`src/cli/index.ts` between the ingestors and the trace providers. `ResourceObservingTraceSink`
sits in the same chain and, on `recordSpanEnd` for a `TOOL` span, asks for that run's samples and
stamps them onto the span.

**The trace layer must not import the prompt layer.** `trace-workshopping.md`'s constraint is that
everything in the trace/ingestion path stays Workers-safe, and a `ResourceRegistry` is
filesystem-bound playground code that will never exist in a Worker. So the dependency is injected,
never imported — the sink takes a lookup, and the run that owns a lease registers into it:

```ts
/** What {@link PromptProvider.resolveInputs} hands back, extended. */
export interface ResolvedInputs {
  functionParams: any[];
  executeValues: Record<string, any>;
  receipts?: Record<string, unknown>;
  release?(): Promise<void>;
  /** Samples every observable resource in this run. Keyed as {@link receipts} is. */
  observe?(): Promise<Record<string, unknown>>;
}
```

`api-routes.ts` is the one place that holds both the freshly minted `traceId` and the `resolved`
lease, so it registers `traceId → resolved.observe` for the life of the run and unregisters it in
the same `onSettled` that already calls `release()`. A provider offering no resources supplies no
`observe`, the map stays empty, and the sink is a pass-through — which is exactly what happens for
every OTLP trace arriving from outside the process.

**Where a sample lands.** `Span.attributes` is free-form `Record<string, unknown>` and already
renders in the details pane, so v1 writes samples under one reserved key
(`evalution.resources`), with no schema migration and no new storage column. Promote it to a
first-class `Span` field if and when the UI wants dedicated rendering — a diff view is the obvious
reason it might (§D).

## D. Size is what kills this if it is ignored

A database snapshot per tool call, times every tool call, times every run, persisted to Turso.
`resource-hierarchy.md` §J.4 flagged receipt size as "probably wanted before traces are persisted
to a DB"; traces are persisted to a DB now, and this proposal multiplies the quantity by the step
count. Four rules, in order of how much they matter:

- **Keep the state small rather than the samples clever.** §E is the real answer to this section: a
  database that is truncated between runs holds the rows *this* run created, so a full snapshot of
  it is small enough that none of the rules below get exercised. Everything else here is a backstop
  for when it is not.
- **The author decides what a sample contains**, because only they know the scope that matters —
  the seeded workspace's tasks, not every row in the database. `observe()` is their query.
- **Samples are capped**, per sample and per run, and a sample over the cap is replaced by a
  truncation marker naming its size rather than stored. A snapshot that silently doubles a trace's
  storage is worse than one that visibly refuses.
- **No sampling on `LLM` spans**, per §B.

**Store whole states; derive the deltas.** Each sample is the full state as `observe()` reported
it, and the difference between two samples is computed when something wants to look at one — the
UI rendering "what this tool call changed", an eval asserting on it. The alternative is storing
`(S₀, Δ₁, Δ₂, …)`, which is smaller and worse: a stored delta is only ever as good as the differ
that produced it, and that differ *will* change (row-level today, field-level the first time
someone wants to assert that only `status` moved), at which point every trace already in the
database is a record of what an old algorithm thought happened. A stored state is self-describing
and re-differs for free. This is not an argument against storing a lot; it is an argument that what
is stored should be facts.

## E. Run isolation: `reset` — moved

Now `specs/resource-arguments.md` §F, in full. It was written here because a database truncated
between runs is what makes a full snapshot per step affordable (§D), and that is still true — but
it earns its place in the other spec for a stronger reason: reusing a recorded receipt means
re-inserting a row under an id that is already taken unless the previous run's row is gone. Reset
is what makes receipt reuse safe, and receipt reuse is what makes a replay comparable to the run
it replays.

## F. What this buys evals

"See the overall effect of all the tool calls together, and write evals that assert on it" is the
whole point of §A's first and last samples, and it implies one forward constraint worth writing
down while it is still free:

> A scorer's input must include the run's resource timelines, not only the model's output.

Nothing here designs the eval API. But a scorer that can see only the final message can assert that
the agent *said* it filed the task; a scorer that can see the `db` resource's before and after can
assert that the task is *in the database*, which is the assertion anyone actually wants and the
reason this feature exists. An eval API that reaches for the timeline later, rather than being
shaped around it now, will have to thread it through a signature that has already shipped.

## G. Reproducing a runtime trace locally: a fidelity ladder

The hard part, correctly identified: **knowing which database records the trace depended on.**
There are three sources for that, and they are usually discussed as if only the expensive one
exists.

| | fidelity | cost | when it is wrong |
| --- | --- | --- | --- |
| 1. The trace itself | the rows the model actually saw | none — already recorded | rows read but never surfaced to the model are invisible |
| 2. Re-fetch from production | today's rows for the ids in the trace | a read-only prod connection | the row changed since the run; deleted rows are gone |
| 3. Record the read-set in production | exactly what the run read | instrumented app, volume, PII | it does not, but you pay for it always |

**Start with (1), and it is stronger than it sounds.** For a tool-using agent, every row the model
ever saw arrived as a tool result, and `ToolSpanDetails` already records each call's `input` and
`output`. The dependency set is therefore *largely already captured in every trace evalution has
ever ingested*, with no production instrumentation at all. What is missing is not data but a
mapping — "this `list_tasks` output corresponds to these rows to seed" — and that mapping is
application knowledge, which is precisely what a playground module is for. It lands on the open
export surface `execution-inputs.md` §B reserved for exactly this kind of growth.

(2) is a documented escape hatch, never a default: it reads as a faithful replay and is not one.
(3) is a later opt-in for teams who want the guarantee, shaped as an SDK helper that records a
read-set under the active span — and note that it produces the same shape as a §A sample, so it
lands in the same place rather than beside it.

## H. `capture` is the inverse of `create`

This is the piece that makes (1) buildable, and the reason it belongs in the same family as
`resource-arguments.md` rather than in a dataset spec of its own:

```
   args ────── create ─────▶  value  +  receipt  +  samples
     ▲                                                │
     └──────────────────── capture ───────────────────┘
```

A resource that knows how to build a situation from arguments is the natural place to put the code
that recovers those arguments from a run that already happened:

```ts
/** The schema-valued subset of `inputs` — what the panel or a dataset binds. */
export type ResourceArgs<N extends ResourceInputs> = {
  [K in keyof N as N[K] extends Resource<any> ? never : K]: ResolvedResourceInputs<N>[K];
};

/** Recovers the arguments that would recreate what a past run depended on. */
capture?: (trace: TraceWithSpans) => ResourceArgs<N> | undefined;
```

Three properties, in order:

- **It is checked twice against the declaration it has to satisfy.** `capture` returns exactly the
  schema-valued subset of `inputs`, so the compiler enforces that a capture is replayable — and
  because those entries are schemas, whatever it returns is *also* validated at run time by the
  same rules a hand-typed value goes through (`resource-arguments.md` §B). A capture that drifts
  from what `create` expects fails at the boundary, naming the parameter, instead of producing a
  dataset row that only misbehaves when someone eventually runs it.
- **A multi-resource extraction is several captures, not a new concept.** A trace that depends on a
  workspace, a user, and three tasks is three resources each recovering their own slice, composed
  the way `inputs` already composes them.
- **`undefined` means "this trace does not involve me"**, which is what makes running every
  in-scope resource's `capture` over a trace a sane operation rather than one requiring the user to
  say in advance which resources were involved.

The output is a dataset row. What this spec fixes about that row — and the only thing it asks the
dataset design to honour — is that **a row can carry a resource's arguments under that resource's
URI**, so that binding the row to a run is the §I-of-`resource-arguments` panel operation and not a
special import path. Everything else about datasets stays open.

## I. Phasing

1. **Fix the receipt wiring.** Stamp `lease.receipts()` onto the recorded inputs. Shared with
   `resource-arguments.md` step 2; nothing below is visible until it lands.
2. **`observe()` at create and at teardown.** The before/after pair, recorded on the root span.
   **This needs no trace-layer coupling at all** — teardown is `onSettled`, which the provider
   already owns — and it is what ask (1) actually asks for. Ships independently of everything else
   here.
3. **`reset`.** Moved to `specs/resource-arguments.md` §F and sequenced there; it is a
   prerequisite for step 4's samples being cheap, and for that spec's receipt round trip being
   safe at all.
4. **Observation points.** `ResolvedInputs.observe`, the traceId→observer registry,
   `ResourceObservingTraceSink`, samples on `TOOL` spans, the size caps.
5. **UI.** Samples in the span details pane; the diff between consecutive samples; the before/after
   pair on the trace itself.
6. *(later, with the eval API)* Timelines in a scorer's input (§F).
7. *(later, blocked on datasets)* `capture`, running every in-scope resource's capture over a
   trace, and the row it writes (§G–§H).

Step 2 is the whole of the first ask for a fraction of the cost of the second, which is why it is
its own step rather than the first half of step 3.

## J. Open questions

1. *Does a slow `observe()` stall ingestion?* The sink chain is awaited, so an observation that
   queries a database sits in the path of span recording. It needs a timeout that drops the sample
   and logs, rather than one that delays the trace — and probably a "sampling is behind" marker so
   a dropped sample is visible rather than silently absent.
2. *Does a sample belong to the span that just ended, or to the gap after it?* Attaching it to the
   span reads as "state after this call", which is what a reader wants, but it means the span is
   mutated after `recordSpanEnd` has already fanned out to live subscribers. Either the sink holds
   the span until its sample is ready (simple, adds latency to the live stream) or samples are
   emitted as a second event against the same span id (more wire, no latency).
3. *An emit callback in `create`.* §B's escape hatch — `create(inputs, { record })` — would let
   an author instrument their own handle for true per-access sampling. Additive, and it changes
   nothing if it is added later; the only reason to decide early is whether `observe()` should be
   defined in terms of it (one mechanism) or beside it (two).
4. *PII in samples.* A sample of a database derived from production data is production data sitting
   in a trace store, and unlike a prompt's messages nobody chose to put it there. At minimum the
   author's `observe()` is the redaction point and the docs should say so; whether the core needs a
   redaction hook is a real question once (3) in §G exists.
5. *Should `capture` live on the resource, or be its own export kind?* On the resource it
   type-checks against `create`, which is a strong argument. Its own kind (`extractor(…)`) composes
   better for a capture that spans several resources and does not force a one-to-one mapping.
   Decide when datasets are designed, not before — but note that `capture` on the resource can be
   added now and subsumed later without changing a URI, exactly as `resource-hierarchy.md` §F
   reasoned about `group()`.
6. *Is serializing on `reset` too blunt for a dataset fan-out?* §E makes 50 rows over one
   resettable database a serial run. The alternative is per-run isolation — a database file, schema,
   or transaction per run — which parallelizes properly and costs more per run, and which an author
   can already express as a run-scoped resource. Worth measuring before the dataset spec assumes
   either: if a run is dominated by model latency, serial is fine and simple.
7. *What identifies a resource's timeline across runs?* `(uri, argument key)` is the identity within
   a run. Comparing the same resource's before/after across two runs — which is what a regression
   eval wants — needs that key to be stable across them, and the argument key is stable only if the
   arguments are. A dataset row makes them stable; a hand-typed binding does not.
