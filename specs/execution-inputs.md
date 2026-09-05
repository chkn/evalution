# Plan: Execution inputs — tool context + code-defined resources

## Context

Running `asgard/apps/api/src/agents/odin/odin.prompt.ts` in the playground fails the moment
the model calls a tool. The prompt's four tools (`list_tasks`, `create_task`, `update_task`,
`post_message`) each declare a `contextSchema`, and the AI SDK requires a matching
`toolsContext` on the `generateText` call. Asgard supplies it at the real call site
(`odin/index.ts:326`):

```ts
const toolContext = { db, runId, rootTaskId: taskId, workspaceId: this.workspaceId };
await generateText({ ...prompt, toolsContext: {
  post_message: toolContext, list_tasks: toolContext,
  create_task: toolContext, update_task: toolContext,
} });
```

The playground never sees that object: `FilePromptProvider.execute` calls
`fileType.loadConfig(...)` and hands the result straight to
`SDKAdapter.executeConfig` → `generateText(config)`. There is no seam for anything that
isn't a positional argument of the prompt function.

Three of the four context fields (`runId`, `rootTaskId`, `workspaceId`) are branded strings
the execute panel could already edit. The fourth, `db`, is a live `DrizzleD1Database` — it
can never be typed into a form.

This splits into **two orthogonal gaps**:

- **(a) Reach.** The playground can only supply positional function parameters. `toolsContext`
  is unreachable.
- **(b) Kind.** The playground can only supply values that survive a form and a JSON round
  trip. Live objects — db handles, API clients, sockets — are unreachable regardless of (a).

Code-defined **resources** answer (b). (a) needs its own answer. They compose, and (b) is the
load-bearing half: without it, closing (a) still leaves odin unrunnable.

---

## Key findings that shape the approach

Measured against the real odin prompt (`TSPromptFileType.parsePrompts` over
`apps/api`, checker path active):

- **The existing four parameters already extract cleanly.** `taskId` →
  `{kind:'primitive', syntax:'TaskId', base:'string'}` (the branded-primitive path), `taskInfo`
  → a two-property object, `threadMsgs` → `array` of `Pick<ThreadMessage,"excerpt">`, `roster`
  → `string`. The panel renders all four today. Nothing needs fixing there.

- **A `Db`-typed parameter explodes.** Adding `ctx: { db: Db; runId: AgentRunId; rootTaskId:
  TaskId; workspaceId: WorkspaceId }` as a fifth parameter produces **5.6 MB** of
  `functionParameters` JSON and takes 1.4 s to parse. ts-proppy's `MAX_DEPTH = 6`
  (`build-prop-type-from-type.ts:9`) bounds depth but not breadth: `Db` has 19 top-level
  members and the checker walks every Drizzle overload beneath them. That payload ships on
  every `GET /api/prompts`.
  → **The naive "just add them as parameters" route is not merely unhelpful for `db`; it is
  actively harmful until opaque types can be marked as non-expandable.** This is a
  prerequisite, not a polish item.

- **`toolsContext` is legal inside a returned config.** `@evalution/vercel-ai-sdk` types a
  prompt as `Parameters<typeof generateText>[0] | StreamTextConfig` (`packages/vercel-ai-sdk/src/index.ts:292`),
  and `toolsContext` is a `generateText` parameter. So a prompt *may* return its own
  `toolsContext` — which makes a zero-new-concept route available (§E, Route A).

- **`contextSchema` survives to runtime.** It is a field on the tool object itself
  (`@ai-sdk/provider-utils` `Tool.contextSchema?: FlexibleSchema<CONTEXT>`), so a loaded
  config can be introspected for which tools need context and what shape. `z.custom<Db>()`
  yields nothing useful, which is exactly the `db` case again — introspection finds the *slot*,
  a resource fills it.

- **Datasets are net-new, DB-backed, and land in OSS — not just cloud.**
  `evalution-cloud/PLAN.md` §3.2 defines a dataset as "a named collection of input rows (and
  optional expected outputs) used to exercise a prompt across cases", behind a
  `DatasetProvider` interface parallel to `PromptProvider`/`TraceProvider`, stored in a local
  Turso DB the OSS tool creates on first run and later syncs as an embedded replica. This
  draws a hard line through what a code-defined resource should be (§C) and adds a third
  input source the wire format must anticipate (§F).

- **`materializeValue` runs in the browser today.** `PlaygroundExecution.resolveParams` calls
  it client-side (`PlaygroundExecution.tsx:73`). ts-proppy's `functionCall` branch does
  `await import(spec.from)` — which cannot resolve in a browser. So import-bound parameter
  values already fail; b0a2fce's sibling commit 503ef8d only made that failure legible. This
  work forces the boundary server-side anyway, and fixes that bug as a side effect.

- **`executeConfig` is fire-and-forget.** It resolves as soon as `generateText` is dispatched
  (asserted in `src/sdk/vercel-ai-sdk/index.test.ts:35`). There is currently **no** handle on
  run completion — so run-scoped resource teardown has nothing to hang off. Needs a small
  change.

- **Trace input recording is half-built, and records the wrong thing for replay.** The native
  (v7) path already round-trips: `telemetry.ts` sets `prompt: { id, functionParameters }` on
  the root span and `telemetry.test.ts:81` asserts it reads back. But two problems. (1) The
  OTel path writes `PROMPT_INPUTS_ATTRIBUTE` (`evalution.prompt.inputs`) and **nothing ever
  reads it back** into `PromptID.functionParameters` — write side only. (2)
  `createTracerForPrompt` stamps those attributes on *every* span it produces, not just the
  root as the native path does. Both matter for replay (§H).

- **`LocalFileProvider.import` does not cache-bust** (`import(pathToFileURL(filePath).href)`).
  Editing a prompt's code and re-running reuses the stale module. Resources inherit this and
  make it far more visible (you *will* iterate on a resource and re-run).

---

## A. Opaque types (prerequisite)

Before anything else, a type that cannot be built from a form must stop being expanded.

Add to ts-proppy's `PropType` an escape hatch the extractor can emit instead of recursing:

```ts
| { kind: 'opaque'; syntax: string }   // e.g. { kind: 'opaque', syntax: 'Db' }
```

**Opacity is a property of the type alone — never of whether a resource exists for it.** An
earlier draft made "some resource declares type `T`" a trigger, which is wrong: it conflates
*"a resource can fill this slot"* (§D matching, which should offer the resource in a dropdown)
with *"this slot has no editor"* (this section). The two are independent. `TaskId` has a
resource and is perfectly editable; `Db` has a resource and is not. Declaring
`resource<TaskId>` must not take the string editor away — you should still be able to type your
own task id, with the resource merely offered alongside.

So the test is structural: **can a value of this type be constructed from a `PropValue`?**

1. **Class instance types.** The type's symbol is declared as a class, or it carries
   private/protected members. This is exactly the motivating case —
   `Db = DrizzleD1Database<typeof schema> & …`, and `DrizzleD1Database` is
   `declare class … extends BaseSQLiteDatabase` (`drizzle-orm/d1/driver.d.ts:7`). No form
   builds one. Intersections count if *any* constituent is a class instance type, which `Db`
   requires.
2. **All-method object types.** An object or interface whose members are all methods or
   function-typed properties, with no data properties — an RPC client handle, a service
   interface. Not a class, equally unconstructible.

Both are cheap checker questions, and both are decided per type without reference to the
playground modules — which removes the ordering constraint an earlier draft needed. There is no
"collect declared types first" pass; extraction just asks about each type as it meets it.

**The size budget stops being a semantic rule.** Collapsing a merely *large* type into a picker
is bad when the type is genuinely editable: a 200-field config interface would become
uneditable because it happened to be big. Keep a ceiling only as a **circuit breaker** — set
high, collapse, and log loudly — on the grounds that shipping 5.6 MB per prompt is a worse
failure than an over-collapsed editor. Treat any firing as a missing rule above, not as
designed behaviour; if it fires in practice the real fix is lazily expanding subtrees on
demand, not a lower threshold.

`ItemEditor` renders `opaque` as the resource picker (§F) — never `JsonFallbackEditor`. The
resulting split is the one that was wanted: a `TaskId` slot keeps its string editor *and* gains
a dropdown offering `seededRootTask`; a `Db` slot has only the dropdown.

## B. Playground modules

Everything in this plan is **playground-only**: code that exists to exercise a prompt from the
playground and that the application itself must never import. The naming makes that
unmissable, and the scoping rule is uniform — **playground modules are scoped by location,
never by export name**:

| Scope   | Location                                          | Applies to                    |
| ------- | ------------------------------------------------- | ----------------------------- |
| Prompt  | `*.playground.ts` in the same directory as a prompt file | prompts in that directory |
| Project | any `*.ts` under `.evalution/playground/`         | every prompt in the workspace |

`odin.playground.ts` beside `odin.prompt.ts` is the idiom, but the rule is directory
membership, not a name pairing — so a directory holding several prompt files can share one
module, and `.evalution/playground/` can be organised into as many files as is convenient.
The directory sits beside the existing `.evalution/config.ts`. Configurable via a
`playgroundIncludePatterns` option mirroring `includePatterns`.

**The export surface is an open set.** A playground module exports tagged values; the loader
walks the module namespace and collects anything it recognises, ignoring the rest (so helpers,
types, and constants can be colocated freely). A **resource** is the first recognised kind —
deliberately not the only one, because the same discovery mechanism is where later playground
concerns belong (code-authored dataset rows, scorers, saved parameter presets). Adding a kind
means teaching the loader one more tag, not changing discovery.

**Resources.** A resource is a named value *produced by code at run time*, in-process, with a
lifecycle. That — not "is it JSON-serializable" — is the defining property: a resource may
well resolve to a plain string (a task id it just inserted); what makes it a resource is that
only running code can produce it.

```ts
// .evalution/playground/db.ts
import { resource } from "evalution";
import { Miniflare } from "miniflare";
import { makeDb } from "../../apps/api/src/lib/db";

export const db = resource({
  label: "Local D1 (.wrangler state)",
  scope: "server",                // created once per server, not per run
  async create() {
    const mf = new Miniflare({
      modules: true, script: "export default {}",
      d1Databases: { APP_DB: "asgard-app" },
      d1Persist: "apps/api/.wrangler/state/v3/d1",
    });
    return { value: makeDb(await mf.getD1Database("APP_DB")), dispose: () => mf.dispose() };
  },
});
```

The **export name is the resource key** (`db`), which is what §D.3 name-matching resolves
against. `create()` returns `{ value, dispose? }`; the value never crosses the wire, and the
panel shows a chip with the label.

**The type is inferred from what `create` returns — there is no `type: "Db"` string.** The
resource's declared type is read off the exported symbol, which resolves to `Resource<T>`;
`T` comes from `create`'s `value` either by inference or from an explicit type argument. A
string would have to match the checker's spelling exactly, goes stale under a rename, and is
unverifiable — and it would buy nothing where inference is unavailable, because a checker-less
parse cannot expand `Db` in the first place (`buildPropType` bottoms out at
`{ kind: 'primitive', syntax: 'Db' }` with no checker), so §D.3 name matching already covers
that mode. The declared type feeds §D matching only; opacity is decided structurally and never
consults it (§A).

**Resources may depend on resources — by reference, not by name.** The seeded-task case is the
motivating one, since it needs the db to insert into:

```ts
// apps/api/src/agents/odin/odin.playground.ts
import { resource } from "evalution";
import { db } from "../../../../../.evalution/playground/db.js";

export const seededRootTask = resource<TaskId>({   // pinned: see below
  label: "Freshly seeded root task",
  needs: { db },                        // resolved first, passed in
  async create({ db }) {
    const id = makeNanoId("tsk_");
    await db.insert(tasks).values({ id, workspaceId: "ws_internal_default" });
    return { value: id };
  },
});
```

**Pin with a type argument when inference widens.** `resource<TaskId>` above is not
decoration: `makeNanoId("tsk_")` is typed `` `tsk_${string}` ``, and `TaskId` is *defined* as
`` `tsk_${string}` `` — the same type, spelled differently. Under §D.2's identity matching the
inferred spelling would miss a `TaskId` slot, so the argument pins it. Unlike a string this is
checked by TypeScript, follows renames, and needs no separate mechanism to read: it is just how
`T` in `Resource<T>` gets fixed. Omit it whenever inference already lands on the right named
type, as with `db`.

Taking `needs` as an object of resource *values* rather than string keys is what named exports
buy: the registry resolves by identity, `create`'s argument is typed from the dependency, and
there is no key-collision problem across the many files a `.evalution/playground/` directory
may hold. Dependencies are resolved as a DAG per run; a cycle is a load-time error.

**Lifecycle.** `scope: 'run'` (default) creates per execution and disposes when the run
settles; `scope: 'server'` memoizes and disposes at shutdown or when the defining module
changes. Run-scoped teardown requires `executeConfig` to return a completion handle — see §G.

## C. What does not belong here: authored data

An earlier draft of this plan gave resource entries a serializable `value` field, so a seeded
message thread could be checked in beside the prompt and used to seed the editor. That is
**deliberately dropped**: per `evalution-cloud/PLAN.md` §3.2 it is a dataset row, and datasets
are net-new, DB-backed, and arrive in the OSS core (a local Turso DB created on first run),
not only in cloud. Shipping authored data as code would mean a second, redundant,
non-syncable way to express exactly what a dataset row expresses better, deprecated shortly
after it lands.

The line:

| | resource (code) | dataset row (DB) |
| --- | --- | --- |
| Substrate | `.ts` in the repo, imported per run | Turso row, CRUD via `DatasetProvider` |
| Can hold | anything, incl. a live `DrizzleD1Database` | JSON only |
| Syncs to teammates / cloud | no — a Miniflare handle can't leave the process | yes, that is the point |
| Versioned with the prompt | yes, in git | no, in a DB |
| Cardinality | one value for one slot | one full input set per run, × N rows |
| Lifecycle | `create` / `dispose`, possibly expensive | none |

They **compose**: running odin over a 50-row dataset still needs exactly one `db`. A dataset
row supplies the serializable inputs; resources supply the ones no row could carry.

The counter-argument is real and unresolved (see Risks): a thread checked into git next to
its prompt is reviewable, branchable, and versioned *with the prompt it exercises*, and a DB
row is none of those. If code-authored data is eventually wanted anyway, it should arrive as
an export path into a dataset, reusing the cross-provider export sketched in PLAN §4.5 for
prompts — not as a parallel resolution mechanism.

## D. Matching a source to a slot

Three strategies, first match wins. **This layer is source-agnostic** — it resolves any
`ExecutionInput` source (§F) onto a slot, so datasets reuse it to map row columns onto
parameters rather than growing their own rules:

1. **Explicit.** `for: 'orchestrate.taskId'` or `for: 'tools.list_tasks.db'` — an escape
   hatch that always works.
2. **Type.** The playground module joins the same `ts.Program` the prompt is parsed in
   (`createPromptProgram` already accepts a multi-file overlay), so the checker can name both
   sides. v1 compares `checker.typeToString` identity: a resource resolving to `Db` is offered
   on every `Db`-typed slot, anywhere, without naming it — and on editable slots it is offered
   *beside* the editor, not instead of it (§A). Identity is known to be too strict —
   `TaskId` and `` `tsk_${string}` `` are one type with two spellings — which is why a resource
   can pin its type argument (§B). Moving to `checker.isTypeAssignableTo` removes that whole
   class of miss and would let the pin be dropped again; it is deferred only because it is N×M
   over slots × resources, not because identity is believed sufficient.
3. **Name.** Key equals slot name. The fallback when the checker is unavailable — which is the
   documented `MemoryFileProvider` situation (`prompt-program.ts`: cross-file types stay
   unresolved and extraction falls back to the syntax tree).

## E. Execute parameters

`toolsContext` is one instance of a general shape, and the plan should carry the general shape
rather than the instance. Split the prompt's inputs by *what they are needed for*:

```ts
interface NormalizedPrompt {
  /** Positional arguments the prompt function takes — what it needs to **render** a config. */
  functionParameters: PropDefinition[];
  /** Named values the SDK needs to **execute** that config, supplied at run time rather than
   *  authored in the file (the AI SDK's `toolsContext`; credentials or a client elsewhere). */
  executeParameters?: PropDefinition[];
}
```

The two are genuinely different questions — *what does this prompt take?* versus *what does
running it require?* — and only the first is answerable from the function signature. This also
sits naturally beside the existing `modelParameters`, which is the third case: config
properties that *are* authored in the file.

Everything downstream then treats execute parameters like any other slot. They are
`PropDefinition[]`, so the panel renders them with the same editors, §A decides opacity the
same way, §D offers resources against them the same way, and §F carries them over the same
`ExecutionInput` union. Nothing in the client or the wire knows the phrase `toolsContext`.

**Deriving them, without the adapter needing a checker or the file type needing SDK
knowledge.** Neither side can answer alone: the `ToolSet → InferToolSetContext` mapping is SDK
semantics, and evaluating it is a TypeScript capability. So each side contributes what it has,
with `FilePromptProvider` as the only place they meet:

```ts
// PromptFileType — knows how to evaluate, not what to ask
readonly language: string;                    // e.g. 'typescript'
resolveTypeProbes?(probes: TypeProbe[]): (PropDefinition | undefined)[];

// SDKAdapter — knows the semantics, not how to evaluate them
getExecuteParameterProbes?(prompt: ParsedPrompt, language: string): TypeProbe[];

interface TypeProbe { name: string; expression: string }
```

**The file type declares the language and the adapter is asked in it.** The alternative — the
adapter tagging each probe with a language and the file type discarding what it cannot read —
gets the negotiation backwards: it makes the adapter generate expressions speculatively and
throw the work away, and it gives an adapter no way to answer *differently* per language rather
than emitting every variant and hoping. Passing `language` in makes the decision the adapter's,
where the knowledge is: unrecognised language, return `[]`. It also takes `language` off
`TypeProbe`, which no longer has to restate what the call already established, and `language`
is worth having on `PromptFileType` regardless — the client already syntax-highlights prompt
source and currently has to infer the dialect.

A caveat to write down: `language` advertises the dialect, not a guarantee. A TS file type
parsed without a checker still says `typescript` and still returns `undefined` from
`resolveTypeProbes`, which is exactly the declared-but-unresolved path below.

`normalizePrompt(prompt, resolvedProbes?)` then assembles `executeParameters`, staying
synchronous — the async, expensive work happens in the provider:

```ts
const parsed  = await this.fileType.parsePrompts(files, rootDir);
const lang    = this.fileType.language;
const probes  = parsed.flatMap(
  p => this.sdkAdapter.getExecuteParameterProbes?.(p, lang) ?? [],
);
const results = await this.fileType.resolveTypeProbes?.(probes);
return parsed.map((p, i) => this.normalizeFilePrompt(p, results?.[i]));
```

**Batching is the point of that shape.** `createPromptProgram` builds one program over all
prompt files and reuses `previous` across rebuilds; resolving probes one prompt at a time would
throw that away. Collecting every probe first lets them all ride in a single program build.
And because a well-written probe is defensive about what it may not find, it does not need the
parse result to decide whether to ask:

```ts
type Config = ReturnType<ReturnType<typeof prompts>["orchestrate"]>;
export type __probe =
  Config extends { tools: infer T extends ToolSet } ? InferToolSetContext<T> : never;
```

`language: "typescript"` is what keeps this honest: a file type that does not speak it returns
`undefined`, and the SDK adapter is not pretending to be language-neutral when the expression
it hands over plainly is not.

**Degrade to declared-but-unresolved, never to silence.** When no probe can run — a non-TS file
type, an in-memory provider with no checker, a resolution failure — the adapter should still
emit the execute parameter with an unresolved type rather than omitting it. "This prompt needs
`toolsContext` and I cannot tell you its shape" is a usable state; today's behaviour is a
silent failure at the first tool call, which is the bug that started this document.

**Execution.** Resolved values reach the adapter, which merges them into the call it already
owns — `generateText({ ...config, ...executeValues })` for the Vercel adapter. Keeping the
merge adapter-side rather than a generic spread avoids assuming an execute parameter's name is
always a config key; it is for `toolsContext`, but that is the adapter's fact to know.

**Route A remains available and is sometimes what you want.** Since a config may legally carry
`toolsContext`, a prompt can take the context as an ordinary parameter and return it:

```ts
orchestrate: (taskId, taskInfo, threadMsgs, roster, ctx: OdinToolContext) => ({
  …,
  toolsContext: { list_tasks: ctx, create_task: ctx, update_task: ctx, post_message: ctx },
})
```

That needs nothing beyond §A–§D, so it unblocks odin before execute parameters exist, and it
stays a legitimate choice for authors who prefer the context explicit in the signature. But it
is a stopgap, not the destination: a tool whose thesis is running your real prompts unmodified
should not be asking every author with contextual tools to restructure them.

### What the probe actually returns

Verified against the real odin prompt — the probe resolves with **zero diagnostics** to:

```ts
{
  list_tasks:   { db: DrizzleD1Database<typeof schema> & { $client: D1Database };
                  workspaceId: `ws_${string}`; rootTaskId: `tsk_${string}` };
  create_task:  { db: …; workspaceId: `ws_${string}`; rootTaskId: `tsk_${string}` };
  update_task:  { db: …; workspaceId: `ws_${string}` };
  post_message: { db: …; runId: `run_${string}`; workspaceId: `ws_${string}` };
}
```

Four things that fall out of that result:

- **Tools without a `contextSchema` are dropped automatically.** `success` does not appear;
  no filtering logic is needed.
- **It is more precise than the real call site.** `odin/index.ts` passes one four-field object
  to all four tools; the inferred type knows `update_task` needs only `{db, workspaceId}`.
- **`db` arrives as an intersection containing a class** (`DrizzleD1Database<…> & { $client }`),
  which is precisely why §A's class rule has to look through intersections.
- **Branded ids arrive as template-literal types** — `` `tsk_${string}` ``, not `TaskId`. They
  edit fine (ts-proppy's `PrimitiveBase` already normalises them to `string`), but it means a
  `resource<TaskId>` would *not* match a `` `tsk_${string}` `` slot under §D.2 identity
  comparison. This is the same spelling problem noted there, now arising from a second
  independent direction, and it makes `isTypeAssignableTo` look less like a refinement and more
  like the thing that should ship.

## F. Wire format and where resolution happens

Today the client materializes and POSTs concrete JSON. A resource reference cannot survive
that. Send *unresolved* inputs instead, over a union with room for all three sources:

```ts
type ExecutionInput =
  | { kind: "value";    value: PropValue }  // typed into the panel
  | { kind: "resource"; uri: string }       // provider-resolved
  | { kind: "dataset";  uri: string };      // DB row cell (not yet implemented)

interface ExecuteRequest {
  functionInputs?: ExecutionInput[];               // positional — functionParameters
  executeInputs?: Record<string, ExecutionInput>;  // by name    — executeParameters (§E)
}
```

Generalising to execute parameters (§E) is what collapses the second field. An earlier draft
carried `toolsContext?: Record<string, Record<string, ExecutionInput>>` — two levels of nesting
that existed only because the AI SDK keys context by tool name. As a named execute parameter,
`toolsContext` is *one* input whose **type** happens to be that nested object, and §A and §D
handle its interior exactly as they would any other object-typed slot: `db` collapses to a
resource picker, the branded ids get string editors. The wire format never learns the word
`toolsContext`, and an SDK with a differently-shaped execution requirement needs no wire change
at all.

The `dataset` variant is declared now and rejected as unimplemented; the point is that the
resolver, the matching layer (§D), and the panel are built over the union from the start, so
`DatasetProvider` plugs into an existing seam instead of forcing a second path.

**A reference is one opaque, provider-interpreted `uri` — not a structured `{ file, key }`.**
Baking `file` into the shape would assume every provider resolves resources off a filesystem,
which is exactly the assumption a provider exposing resources over RPC would break. A single
string leaves the grammar to whoever resolves it, and it is not a new convention: prompts are
*already* identified this way. `parsePromptId` splits on the last `#` and joins the left half
against `rootDir` (`file-prompt-provider.ts`), and `globalId` is minted as
`` `${moduleId}#${name}` `` — so `src/agents/odin/odin.prompt.ts#orchestrate` and
`odin#orchestrate` are both live examples of "locate a module, then name an export within it".
Resources want the identical shape:

```
src/agents/odin/odin.playground.ts#seededRootTask   // prompt-scoped
.evalution/playground/db.ts#db                      // project-scoped
rpc://inventory/resources#db                        // a hypothetical RPC provider
```

Three consequences worth being explicit about:

- **No scheme is required, and none should be invented for the file case.** A relative
  reference with a fragment is a perfectly legal URI reference, so `db.ts#db` is honest as a
  `uri` while staying byte-identical to the prompt-ID convention. A provider that needs a
  scheme (`rpc:`) is free to require one; the resolver is the authority on its own grammar.
- **Relative, never absolute — this is what makes refs portable.** They are already persisted
  in `localStorage`, and the roadmap points at run configurations living in a synced DB, where
  a machine-absolute `file:///Users/alex/…` would break for every teammate. Resolving relative
  to the provider's `rootDir` mirrors `parsePromptId` and keeps refs stable across machines.
  It also leaves room for a provider to accept a move-stable alias form later, exactly as
  `globalId` does for prompts.
- **Same `#` caveat as prompt IDs.** Splitting on the last `#` means a literal `#` in a path is
  not representable. Prompt IDs have carried that limitation since day one; inheriting it is
  better than diverging.

The dataset variant gets a `uri` for symmetry, but its internal grammar is deliberately left
open: a dataset reference should be designed alongside `DatasetProvider`'s query surface
rather than guessed at now.

`needs` is unaffected — it stays an identity-based reference between resources inside a
module (§B), an authoring concern that never reaches the wire.

**`functionParams` and `stream` are removed outright, not deprecated.** The client and server
ship in one package and are only ever run together, and the HTTP API is documented nowhere in
`docs/` — there is no second implementation to keep in step and no contract to break, so a
deprecated field would be dead weight that every future reader has to rule out.
`ExecuteRequest.stream` in particular has never been read by anything: it is present in the
initial commit, absent from the client's request body, and ignored by the route, which
destructures `functionParams` alone (`api-routes.ts:282`). Execution has always been
fire-and-forget with results arriving over the trace SSE stream, so the flag never had a
meaning to implement. Deleting both leaves `ExecuteRequest` as exactly the two fields that
are read.

`materializeValue` moves server-side (it is already DOM-free), with resource refs resolved
through a `ResourceRegistry`. Besides enabling resources this fixes import-bound `functionCall`
parameters, which cannot resolve in a browser at all.

**The provider contract does not change with the wire format.** `PromptProvider.execute(
promptId, params: any[], options)` is public extensibility surface, and it should keep taking
plain materialized values — a provider that has no resources should never have to recognise
an `ExecutionInput`, let alone interpret someone else's `uri` grammar. So resolution happens
*before* `execute` is called, behind one new optional hook:

```ts
resolveInputs?(promptId: string, inputs: {
  functionInputs?: ExecutionInput[];
  executeInputs?: Record<string, ExecutionInput>;
}): Promise<{ functionParams: any[]; executeValues: Record<string, any> }>;
```

One call covering both halves rather than one per half: a run-scoped resource referenced by
both a function input and an execute input must be created **once** per run, which is only
decidable when the resolver sees every input together.

The route calls it when present and otherwise falls back to a built-in resolver that handles
`kind: "value"` only. `FilePromptProvider` implements it over its `ResourceRegistry`; every
existing custom provider keeps working untouched, and `execute` still receives `any[]`. This
also settles where the code lives: the registry stays provider-side (resource discovery is
file-globbing, a `FilePromptProvider` concern), while the route stays generic.

**UI.** Each slot gains a small dropdown listing matching sources plus "Custom". Choosing a
resource replaces the editor with a labelled chip — a resource's value is not known until run
time, so there is nothing to seed an editor with (that affordance belongs to dataset rows,
§C). For an `opaque` slot the dropdown *is* the control; when nothing matches, the existing
"Parameter is required" error gains a hint pointing at the `*.playground.ts` convention.
Persistence reuses the existing `pg-exec-params:<globalId>` key — a slot now stores an
`ExecutionInput` rather than a bare `PropValue`.

## G. Lifecycle plumbing

- `executeConfig` must expose run completion (a returned `{ done: Promise<void> }`, or an
  `onSettled` option) so run-scoped resources dispose. Its fire-and-forget resolution is
  deliberate — the route returns a trace id immediately — so this is additive, not a change
  to when the HTTP response is sent.
- Playground modules are imported with a `?v=<mtime>` cache-buster so editing one and re-running
  picks up the edit. Prompt modules arguably deserve the same treatment; call it out but
  scope it separately.
- **Trust:** playground-module code runs in the server process with full filesystem and network access.
  This is the same trust level the prompt file already has (it is imported and executed on
  every run), so it introduces no new boundary — but it should be documented.

---

## H. Replaying a trace's inputs

Opening a past trace and getting the execute panel repopulated with what it ran is a stated
goal. The data model already anticipates it — `PromptID.functionParameters` exists, and the
native path populates it on the root span — but the recorded content is wrong for this design,
in a way that is cheap to fix now and expensive to retrofit.

**Record the recipe, not the resolution.** Today `FilePromptProvider.execute` passes
`identity: { …, functionParameters: params }` where `params` is the already-materialized
`any[]`. Under this plan one of those entries is a live `DrizzleD1Database`; serializing it
into a span is at best a useless blob. So `PromptSpanInfo` should carry the **unresolved**
inputs instead:

```ts
functionInputs?: ExecutionInput[];               // replaces functionParameters: unknown[]
executeInputs?: Record<string, ExecutionInput>;  // §E
```

`ExecutionInput` is JSON-safe by construction — a `PropValue` or a `uri` string — so it always
serializes, and what gets stored for a resource is precisely the thing that can be replayed.

**Fidelity differs by kind, and the UI must not paper over it:**

| kind | on replay |
| --- | --- |
| `value` | exact restore, including the `PropValue` form (a template stays a template, rather than the flattened string a materialized value would have left) |
| `resource` | re-runs `create()`: an *equivalent* value, not the same one — a fresh db handle, and a **new** seeded task id |
| `dataset` | exact, as long as the row still exists |

So "the inputs it was originally run with" is literally true for values and dataset rows, and
means "the same recipe" for resources. The panel should show the resource chip and say it will
be re-created — never present a restored value it cannot actually restore.

**Leave room for a receipt.** A resource may optionally record a serializable summary of what
it produced (`seededRootTask` → `"tsk_abc123"`), so a trace can *display* the value it ran with
even though replay mints a new one, and so a future `restore(receipt)` could pin it. Shape the
recorded input to allow an optional `receipt` field now; do not build the restore path yet.

**Two gaps to close for this to work on both telemetry paths:**

1. `PROMPT_INPUTS_ATTRIBUTE` needs a reader. It is written by `getPromptSpanAttributes` and
   parsed back by nothing, so the OTel path cannot replay at all until an ingestor maps it onto
   `PromptID`.
2. Inputs belong on the **root span only**. `createTracerForPrompt` currently stamps them on
   every span, which is invisible when the inputs are `["Ada"]` and wasteful when they are a
   50-message thread — multiplied by span count, and then persisted and synced once traces move
   to a DB.

**Signature drift is a versioning problem, so replay waits for versioning.** A trace may
reference a prompt whose parameters have since changed. Rather than guess at a match, replay is
**gated on prompt versioning and dataset versioning**: with both in place a trace pins the exact
prompt version and dataset version it ran against, the recorded inputs always match the
signature they were captured against, and drift stops being a failure path. Datasets face the
identical problem under a saved row, and versioning answers it the same way — which is why
replay is sequenced after both rather than shipping a heuristic matcher now.

Two refinements to carry into that work:

- **For file-based prompts, git is the version, and the playground should not be checking out
  old commits.** Versioning as sketched in `evalution-cloud/PLAN.md` §5 attaches `versions` to
  `NormalizedPrompt` in `TursoPromptProvider` — prompts-as-data, cloud-authored mode. Odin is a
  file prompt, so the cheap equivalent is to record the `PropDefinition[]` **alongside** the
  inputs at run time. Replay then diffs two known shapes instead of inferring a match, which is
  both simpler and more honest, and it works with no version store at all.
- **Two replay intents, separable once versions exist.** *Reproduce* pins everything and needs
  versioning. *Re-run against current* takes the recorded inputs and runs them against today's
  prompt — the more common playground action, where a changed signature is the point rather
  than an error. Under that intent the §D matching layer still has a job; it is just a mode the
  user opts into, not an unavoidable guess.

**Resources sit outside both versioning systems, deliberately.** A trace can pin prompt v3 and
dataset row v7, but `db.ts#db` is live code in the working tree — replay runs *today's*
`create()`. That is usually what is wanted (the point of a resource is a fresh runtime thing,
and you are normally replaying to exercise current seeding), but it means a replay is never a
hermetic reproduction. The panel should distinguish pinned inputs from re-created ones, and the
optional `receipt` above is what lets a trace still show what a resource produced at the time.

**This is where the relative `uri` (§F) earns out.** A trace that syncs to a teammate carries
`.evalution/playground/db.ts#db`, which resolves against *their* `rootDir`. Had the ref been an
absolute path or a `file:///Users/alex/…` URI, every replayed trace would be machine-local.

## Phasing

1. **§A opaque types + size budget.** Standalone value; unblocks everything else.
2. **§F server-side resolution + the `ExecutionInput` union.** No user-visible change;
   fixes import-bound parameters.
3. **§B/§D resources with explicit + name matching, and the picker UI.** Odin runs, via
   Route A (§E) — the stopgap that needs no execute-parameter machinery.
4. **§D type matching through the checker.**
5. **§E execute parameters** — `NormalizedPrompt.executeParameters`, the probe pair, and the
   `executeInputs` half of the wire. A static type probe rather than a load-and-call cycle, so
   far cheaper than first scoped; reconsider whether it should precede step 4, since it shares
   the checker plumbing and removes Route A's restructuring tax.
6. *(later, separate)* `DatasetProvider` fills the third `ExecutionInput` variant.
7. *(later, blocked on prompt + dataset versioning)* §H trace replay. Two pieces land early
   anyway, because both are nearly free now and unrecoverable for traces captured before them:
   record `inputs` instead of `functionParameters` as part of step 2 while that shape is being
   changed regardless, and record the prompt's `PropDefinition[]` beside them.

Steps 1–3 are what odin actually needs.

## Risks / open questions

1. *Code-authored data stays unresolved.* §C defers it to datasets, but the git-versioning
   argument does not go away. The open export surface (§B) is where it would land if it comes
   back — a `dataset()` kind registering rows from a playground module into `DatasetProvider`,
   rather than a parallel resolution path. Revisit once `DatasetProvider` exists.
2. *Structural opacity may under- or over-fire.* The class and all-method rules (§A) are
   narrow by design, so a genuinely unconstructible type that is neither — say an interface
   mixing data with a `Symbol.asyncIterator` — still expands, and a class-shaped type someone
   *does* want to edit as data would collapse. Both should be observable: log what the circuit
   breaker collapses, and surface an opaque slot with no matching resource as an explicit
   "needs a resource" state rather than an empty dropdown.
3. *Type inference vs pinning.* The `type` string is gone (§B) in favour of inference from
   `create`, with `resource<T>()` to pin. The residue is knowing *when* a pin is needed: under
   identity matching that is "whenever the inferred spelling differs from the slot's", which is
   not obvious at authoring time. The panel should make a resource that matched nothing visible
   rather than silently absent, and §D.2 assignability retires the question entirely.
4. *`needs` ordering vs `scope`.* A `run`-scoped resource may depend on a `server`-scoped one
   (seeded task → db), but not the reverse; that must be enforced at load time, and a
   `server`-scoped resource that transitively depends on a `run`-scoped one is a config error.
   Resolution is by identity, so this is checkable at load without a name registry.
5. *Watch invalidation.* A changed playground module must dispose server-scoped instances and
   refresh any panel offering them; the `PromptChangeEvent` stream is the obvious carrier but
   is keyed by prompt id, so playground-module changes need to fan out to every prompt in scope.
6. *Miniflare in the example* pulls a worker runtime into the playground process. It works, but
   the first `create()` is slow — hence `scope: 'server'`. Confirm dispose actually releases
   the workerd child process.
7. *`*.playground.ts` sits inside the application's source tree,* so the app's own tsconfig and
   bundler will pick it up by default — exactly the confusion the naming exists to prevent, and
   a real breakage risk when a playground module imports something the app's runtime cannot
   take (`miniflare` inside a Workers build). The name alone is not enough: document that
   projects should add `**/*.playground.ts` to their build/typecheck excludes, and consider
   emitting a warning when a playground module is reachable from a prompt file's own imports.
   (`.evalution/playground/` has no such problem — it is already outside the app.)
8. *A throwing playground module must not take the server down.* `.evalution/playground/**` is
   imported eagerly at startup; an import-time failure should degrade to "this module's
   resources are unavailable", surfaced in the panel, not a boot crash.

## Critical files

- `ts-proppy/src/types/prop-type.ts`, `src/extraction/build-prop-type-from-type.ts` — `opaque`
  kind + breadth budget
- `ts-proppy/src/react/ItemEditor.tsx` — route `opaque` to the resource picker
- `src/prompt/prompt-provider.ts` — optional `resolveInputs` hook; `execute` signature
  unchanged
- `src/prompt/file/file-prompt-provider.ts` — playground-module discovery,
  `playgroundIncludePatterns`, `resolveInputs` over the `ResourceRegistry`
- `src/prompt/playground/` *(new)* — `resource()` helper, `ResourceRegistry`, `needs` DAG,
  lifecycle/disposal
- `src/prompt/execution-inputs.ts` *(new)* — source-agnostic slot matching (§D)
- `src/prompt/file/ts/prompt-program.ts` — include playground modules in the program for §D.2
- `src/sdk/sdk-adapter.ts` — `getExecuteParameterProbes`, `TypeProbe`, `normalizePrompt` gains
  the resolved-probe argument, `executeConfig` gains `executeValues`
- `src/sdk/vercel-ai-sdk/index.ts` — the `InferToolSetContext` probe, `toolsContext` merge,
  run-completion handle
- `src/prompt/file/prompt-file-type.ts` + `ts/ts-prompt-file-type.ts` — `language`, plus
  `resolveTypeProbes`:
  inject snippets through `createPromptProgram`'s existing `sources` overlay in one batched
  build, resolve each alias, convert with `buildPropTypeFromType`
- `src/shared/types.ts` — `NormalizedPrompt.executeParameters`; `ExecutionInput` (single `uri`
  per reference variant); `ExecuteRequest` loses `functionParams` and `stream`, gains
  `executeInputs`
- `src/trace/prompt-tracer.ts` — `PromptSpanInfo.functionInputs`/`executeInputs` replace
  `functionParameters`, plus
  the prompt's `PropDefinition[]` snapshot; stamp both on the root span only (§H)
- `src/trace/trace-types.ts` — `PromptID.functionInputs`/`executeInputs`
- `src/trace/otel-trace-ingestor.ts` — read `evalution.prompt.inputs` back (§H, currently
  write-only)
- `src/sdk/vercel-ai-sdk/telemetry.ts` — carry `identity.functionInputs`/`executeInputs` onto
  the root span
- `src/server/api-routes.ts` — accept `inputs`/`toolsContext`; call `resolveInputs` (or the
  value-only fallback) before `provider.execute`
- `src/server/api-routes.test.ts`, `src/server/service-worker.test.ts` — the two places that
  post `functionParams` today
- `src/client/components/PlaygroundExecution.tsx` — source dropdown, `ExecutionInput` in
  `localStorage`
- `src/index.ts` — export `resource`

## Verification

- **Unit (`vitest`, `MemoryFileProvider`):** discovery by directory membership (a
  `*.playground.ts` serving two sibling prompt files; several files under
  `.evalution/playground/` merging into one scope); non-resource exports in a playground
  module ignored without error; name/explicit matching precedence; `needs` resolved as a DAG
  by identity and cycles rejected at load; run-scoped `dispose` called exactly once after the
  run settles; server-scoped memoized across two runs and disposed on module change; an
  import-time throw in one playground module leaves the others usable.
- **Regression on the finding:** parse a prompt with a `Db` parameter and assert
  `functionParameters` serializes under a fixed budget (it is 5.6 MB today) and that the slot
  extracts as `opaque` via the class rule — with **no** playground module present, since
  opacity must not depend on one.
- **Opacity is structural:** a prompt taking `taskId: TaskId` keeps its string editor after
  `resource<TaskId>` is declared, and the resource is offered beside it. The inverse of the
  `Db` case, and the regression that would catch §A.1 regrowing a resource-declared trigger.
- **Import-bound parameters:** a parameter whose value is a `functionCall` with an import
  binding now materializes server-side — the case that fails in the browser today.
- **Provider contract:** a custom provider that implements `execute` but *not* `resolveInputs`
  still runs a prompt whose inputs are all `kind: "value"` — the fallback resolver covers it,
  and `execute` sees plain `any[]`.
- **Ref portability:** every `uri` a run produces is `rootDir`-relative, so a saved input
  selection resolves identically after the project is cloned to a different path — asserted by
  resolving the same ref under two different `rootDir` values.
- **Input round trip (§H):** execute a prompt with one `value` and one `resource` input, then
  read the trace back and assert the recorded `inputs` reproduce the panel state — the
  `PropValue` restored in its original form, the resource restored as a chip rather than a
  materialized value. Cover both telemetry paths, since the OTel one has no reader today.
- **Execute parameters (§E):** against a fixture prompt with contextual and non-contextual
  tools, the probe yields a `toolsContext` `PropDefinition` covering exactly the contextual
  tools, with no diagnostics; a prompt with no `tools` property yields no execute parameter
  rather than an error; and a file type without `resolveTypeProbes` still yields the parameter
  with an unresolved type, never silence.
- **Probe batching:** parsing N prompts with probes builds one program, not N — asserted by
  counting `createPromptProgram` calls.
- **Wire union:** an `ExecutionInput` of kind `dataset` is rejected with a clear
  "not implemented" error rather than a type crash, so the seam is exercised before
  `DatasetProvider` exists.
- **Playwright (`*.pw.tsx`):** the dropdown lists matching resources; picking one replaces the
  editor with a labelled chip and round-trips through `localStorage`; an `opaque` slot with no
  matching resource shows the hint, not a JSON textarea.
- **End to end, the actual goal:** `npm run dev` in asgard, open `odin#orchestrate`, pick the
  D1 resource plus a seeded task, Run — and see `list_tasks` return real rows in the trace.
