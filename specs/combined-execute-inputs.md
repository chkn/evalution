# Proposal: Combined mode for fanned-out inputs

## Context

`specs/execution-inputs.md` shipped, and odin's `toolsContext` now extracts exactly as §E
predicted. Measured against `apps/api` (`FilePromptProvider.getAllPrompts`, checker path
active, 1.1 s):

```ts
toolsContext: {                                  // InferToolSetContext<typeof tools>
  list_tasks:   { db: opaque; workspaceId: `ws_${string}`; rootTaskId: `tsk_${string}` },
  create_task:  { db: opaque; workspaceId: `ws_${string}`; rootTaskId: `tsk_${string}` },
  update_task:  { db: opaque; workspaceId: `ws_${string}` },
  post_message: { db: opaque; runId: `run_${string}`; workspaceId: `ws_${string}` },
}
```

That is **11 editable leaf slots covering 4 distinct values**. `db` appears 4×, `workspaceId`
4×, `rootTaskId` 2×, `runId` 1×. To run the prompt once you pick the same resource from four
identical dropdowns and type the same workspace id into four identical text fields.

The precision is real and the plan was right to keep it — `update_task` genuinely needs only
`{db, workspaceId}`, which is more than `odin/index.ts:316` knows, where one four-field
`toolContext` object goes to all four tools. But the *authoring* shape at the real call site is
one object, and the panel should be able to match it.

**The ask:** a combined mode that lists those fields once, deduped, and fans each value out to
every member that needs it.

---

## A. What is being merged

Stated structurally, so it is not an AI-SDK special case. The vocabulary is deliberately free of
"tool" — a tool is what odin's members happen to be, not what the machinery knows about:

> A **fan-out slot** is a slot whose type is `object` and ≥2 of whose properties are themselves
> `object`-typed. Those properties are its **members** (`list_tasks`, …); the immediate
> properties of each member are **fields** (`db`, `workspaceId`, …).
>
> Fields group by `name` + `type.syntax`. A group is one row in combined mode, and its value is
> written to the path of every member that declares it.

Four consequences:

- **`type.syntax` identity is the merge key, and it is the right strictness.** Two `db` fields
  merge because the checker printed the same string for both. If one member took a different
  `db`, the strings would differ and they would stay separate rows — correct, and it fails
  closed. This is string comparison over data the client already has: no checker, no new
  provider surface.
- **A group of one still shows.** `runId` is a row like any other, tagged `post_message`. The
  combined list is *all* the fields, deduped — not just the shared ones — because a list that
  hid the singletons would not be a complete input form.
- **Depth stops at one level.** A field whose own type is an object is a single group member
  edited by its normal `ItemEditor`, not recursively merged. Nothing motivates deeper merging,
  and `MAX_SLOT_DEPTH = 4` already bounds what the panel offers sources for.
- **It applies to `functionParameters` too**, by the same rule, for free. No current prompt
  shape triggers it; that is fine — the rule is about structure, not about which half of
  `NormalizedPrompt` a slot came from.

Odin under this rule: **11 controls → 4**, and the `db` resource is picked **once** instead of
four times.

## B. Which layout a slot opens in

Structure says a slot *can* be combined. It cannot say whether it *should* be — and guessing
from the data ("merge when the members happen to agree") is a heuristic that would silently
rearrange the form based on what you last typed. So the default is carried, not inferred:

```ts
/** How a fan-out slot's fields are laid out in the execute panel. */
export type InputLayout = "combined" | "expanded";
```

**`expanded` is the default for everything.** It is today's behaviour, it is what the type
literally says, and a slot that fans out for a real reason should look like it does.

**An adapter overrides that for slots whose fan-out is an artifact of its own API shape.**
`toolsContext` is exactly that: the AI SDK keys context by tool name because tools are
*resolved* individually, not because authors think of four separate contexts — `odin/index.ts`
builds one object and hands the same reference to all four. The adapter is the only party that
knows this, so it says so:

```ts
// NormalizedPrompt — mirrors PromptInputSources' functionSlots/executeSlots split,
// which exists because a function parameter and an execute parameter may share a name.
/** Slot path → how to lay it out. Any path not named here uses `expanded`. */
inputLayout?: {
  functionSlots?: Record<string, InputLayout>;
  executeSlots?: Record<string, InputLayout>;
};
```

```ts
// VercelAISDK.normalizePrompt, beside the executeParameters it already assembles
inputLayout: executeParameters && {
  executeSlots: { [VercelAISDK.TOOLS_CONTEXT_PROBE.name]: "combined" },
},
```

**Not on `TypeProbe`, and not on `PropDefinition`.** `TypeProbe` is the contract between an
adapter and a *file type*, and a file type has no business carrying a UI layout preference it
will never read — the probe is about resolving a type, and it should stay that. `PropDefinition`
is ts-proppy's, with no metadata bag; a playground-form arrangement is not something to widen
that type for. `NormalizedPrompt` is where the playground's own view of a prompt already lives,
and the slot-path-keyed map is the idiom `PromptInputSources` established one field earlier.

**Precedence, most specific first:**

1. **The user's stored choice for this prompt and slot.** Always wins.
2. **Stored inputs whose members disagree → `expanded`, regardless of what the hint says.** A hint must
   never silently merge values that are already different; this rule only ever falls *toward*
   expanded, so it can only reveal, never destroy.
3. **The adapter's `inputLayout`.**
4. **`expanded`.**

The toggle itself appears whenever some group has ≥2 members — a hint changes which way it
starts, never whether it exists.

## C. Where the dedupe happens: the panel, not the wire

The layout hint is one enum per slot. **Everything else stays in `src/client/components/`**:
combined mode is a view over the existing `ExecutionInput` tree, and what gets sent, persisted,
and recorded is the fully expanded per-member form, byte-identical to what expanded mode sends
today.

```ts
// combined row: db = <resource>, workspaceId = "ws_internal_default", rootTaskId = "tsk_x"
// what goes on the wire — unchanged shape, unchanged resolver:
executeInputs: {
  toolsContext: { kind: "object", properties: {
    list_tasks:  { kind: "object", properties: {
      db: { kind: "resource", uri: ".evalution/playground/db.ts#db" },
      workspaceId: { kind: "value", value: { kind: "primitive", value: "ws_internal_default" } },
      rootTaskId:  { kind: "value", value: { kind: "primitive", value: "tsk_x" } } } },
    create_task:  { …same three… },
    update_task:  { …db + workspaceId only… },
    post_message: { …db + workspaceId + runId… },
  } },
}
```

The `object` variant of `ExecutionInput` already exists for exactly this — "an object assembled
from per-property inputs, so a resource can fill one field of an otherwise hand-edited object"
— so expansion is a pure function into a shape the server already resolves.

Three reasons to keep the *arrangement* client-side even though the *default* is not:

1. **`ExecutionInput` is the replay record.** Under §H a trace stores these to replay them. A
   `{kind:"fanout"}` variant would record how the form was arranged rather than what the SDK
   received, and every future consumer — trace replay, `DatasetProvider`, any second client —
   would have to learn to expand it. The expanded tree is the honest recipe and already
   round-trips.
2. **`resolveExecutionInput` needs no change, and the resource is still created once.**
   `ResourceRegistry.lease()` memoizes run-scoped instances by resource *identity*
   (`resource-registry.ts:195`), so one `db` referenced from four member paths creates one
   handle and disposes it once. The 4× duplication on the wire costs nothing at run time. Worth
   a test rather than a comment.
3. **Per-member precision survives.** Merging is a display choice the user can undo, not a
   narrowing of what the panel can express.

## D. State

Expanded mode is untouched — today's `SlotSelection` (`{ value?, resources? }` keyed by dotted
path), today's `ItemEditor` + plugin. Combined mode is a sibling branch holding one
`SlotSelection` per **group** instead of one per parameter:

```ts
/** Editor state for a fan-out slot shown as one deduped list. */
interface CombinedSelection {
  /** Group key (`db`, `workspaceId`) → that row's value and/or resource choice. */
  fields: Record<string, SlotSelection>;
}
```

Reusing `SlotSelection` per row is what makes each row behave exactly like a top-level slot:
`value` for the editor, `resources[SELF]` for the dropdown. `SourceRow` moves out of
`ExecutionInputEditor.tsx` into its own module so both modes render the identical control.

**`expand(groups, combined) → ExecutionInput`** builds the tree in §C; **`collapse(groups,
input) → CombinedSelection | null`** reads a stored tree back, returning `null` when any group's
members disagree — which is what feeds precedence rule 2.

Persistence gains one field beside the inputs it already stores:

```ts
interface StoredInputs {                 // pg-exec-params:<globalId>, otherwise unchanged
  functionInputs?: Record<string, ExecutionInput>;
  executeInputs?: Record<string, ExecutionInput>;
  /** The user's explicit choice, by slot path. Absent until they touch the toggle. */
  layout?: { functionSlots?: Record<string, InputLayout>;
             executeSlots?: Record<string, InputLayout> };
}
```

Written only when the toggle is used, so a stored entry always means "the user decided this"
and never shadows a later change to the adapter's default.

**Toggling** expanded → combined with disagreeing members keeps the first member's value and
names the ones it overwrites, in a line under the toggle. Combined → expanded is lossless: it is
the expansion that was going to be sent anyway.

## E. What a row shows

```
toolsContext *                                  InferToolSetContext<typeof tools>
Per-tool context required by tools that declare a contextSchema.
                                              [ Combined ▾ ]   4 members

  db *            DrizzleD1Database<…> & { $client: D1Database }      all 4
                  [ Local D1 (.wrangler state) ▾ ]  ⟨chip⟩ created once per server
  workspaceId *   `ws_${string}`                                      all 4
                  [ ws_internal_default        ]
  rootTaskId *    `tsk_${string}`              list_tasks, create_task
                  [ tsk_…                      ]
  runId *         `run_${string}`              post_message
                  [ run_…                      ]
```

- **Every row names its members**, by their own property names — "all 4" when it is all of them,
  an explicit list otherwise. This is the one thing combined mode hides, so it is the one thing
  the row must always say.
- **A group is required if any member is required.** Optional-everywhere stays optional.
- **The dropdown offers resources matching *every* member path** — the intersection over
  `inputSources.executeSlots`. Type-driven matching makes members agree by construction (same
  `type.syntax`), so the intersection is only ever narrower for a resource pinned with `for:` to
  one specific member's slot. That case is real but deliberate: a resource aimed at one member
  is offered in expanded mode, and the combined row is not the place to half-apply it. When the
  intersection drops a candidate some member matches, say so beside the toggle rather than
  leaving it mysteriously absent.
- **Opaque rows behave as they do now** — the dropdown *is* the control, and with no matching
  resource the row shows the existing "no value editor for this type" hint. Combined mode
  changes how many times you answer, never whether a slot is answerable.

## F. Alternatives considered

**Infer the default from the data** (open combined whenever the stored members agree, which
includes the all-empty first run). This was the previous draft, and it is worse than it looks: a
form that rearranges itself according to what you last typed is hard to predict, and on a first
run "the members agree" is vacuously true, so it amounts to defaulting everything to combined
with extra steps. The surviving piece is precedence rule 2 (§B) — disagreement forces
`expanded` — which is the safe half of the same observation and never merges anything on its
own.

**Dedupe in the SDK adapter.** `normalizePrompt` could emit `toolsContext` pre-merged and
`executeConfig` could fan it back out. Rejected on three counts: the fan-out at execute time
either has to re-derive each member's field set or pass every field to every member (which
breaks against a `.strict()` `contextSchema`); the per-member precision the probe worked to
obtain would be destroyed for every client rather than folded for one view; and the trace would
record a shape that never reached `generateText`. The adapter should contribute the one thing
only it knows — that this fan-out is incidental — not perform the merge.

**Ship the grouping itself on `NormalizedPrompt`,** beside `inputSources.executeSlots`.
Rejected because grouping needs nothing the client lacks — it is `name` + `type.syntax` over a
`PropDefinition` tree already in hand — so shipping it adds a wire field, a second place for two
walks to disagree, and a provider obligation for something purely structural.
`matchSourcesToSlots` needs the checker; grouping does not. The line this draws is the point of
§B: **the default layout crosses the wire because it is SDK semantics the client cannot derive;
the grouping does not because it is structure the client can.**

**A `{kind:"fanout"}` wire variant.** See §C.1. It buys a smaller request body and costs every
consumer of `ExecutionInput`, including the replay path that does not exist yet.

## G. Non-goals

- **Merging across parameters.** `taskId` and `toolsContext.*.rootTaskId` are the same value at
  the real call site (`odin/index.ts:317`), but they are differently named slots in different
  halves of the prompt, and guessing that they are one input is exactly the kind of inference
  §D of the parent plan refused to make. If it is wanted later it is an explicit link, not a
  heuristic.
- **Per-row overrides inside combined mode** ("all members except `post_message`"). The toggle
  is the escape hatch; a third, half-merged state is not worth the state machine.
- **This does not remove the need for a resource.** Odin still needs
  `.evalution/playground/db.ts#db` before it will run — combined mode makes the `db` slot one
  dropdown instead of four, not zero.

## H. Files

- `src/shared/types.ts` — `InputLayout`; `NormalizedPrompt.inputLayout`.
- `src/sdk/vercel-ai-sdk/index.ts` — emit `executeSlots: { toolsContext: "combined" }` from
  `normalizePrompt`.
- `src/client/components/combined-inputs.ts` *(new)* — `fanOutGroups()`, `expand()`,
  `collapse()`, and the precedence resolution in §B; pure, no React, so the interesting half is
  unit-testable.
- `src/client/components/SourceRow.tsx` *(new)* — extracted verbatim from
  `ExecutionInputEditor.tsx` so both modes share one control.
- `src/client/components/CombinedInputEditor.tsx` *(new)* — the deduped list.
- `src/client/components/ExecutionInputEditor.tsx` — import `SourceRow`; otherwise unchanged.
- `src/client/components/PlaygroundExecution.tsx` — per-slot layout state, `layout` in
  `StoredInputs`, `expand()` in `buildRequest`.
- `src/client/styles.css` — the toggle and the member tag.
- `src/client/components/__fixtures__/executionFixtures.ts` — an odin-shaped four-member fixture
  (the one above, trimmed) beside the existing single-member one.

## I. Verification

- **Unit (`vitest`) over `combined-inputs.ts`:** the odin shape groups into `db`(4),
  `workspaceId`(4), `rootTaskId`(2), `runId`(1); a field whose `type.syntax` differs between two
  members does *not* merge; `expand` produces per-member objects containing only the fields that
  member declares (`update_task` gets no `rootTaskId`); `expand ∘ collapse` is identity on an
  agreeing tree; `collapse` returns `null` on a disagreeing one; a slot with a non-object member
  leaves it ungrouped.
- **Precedence (§B), each rule pinned by its own case:** no hint and no stored choice opens
  expanded; `executeSlots: { toolsContext: "combined" }` opens combined; a stored explicit
  `expanded` beats that hint; stored inputs that disagree open expanded *despite* the hint, with
  nothing overwritten.
- **The adapter emits the hint:** `VercelAISDK.normalizePrompt` yields
  `inputLayout.executeSlots.toolsContext === "combined"` when it emits the parameter, and no
  `inputLayout` at all when the prompt has no tools — asserted in the adapter's own tests, not
  the client's, since that is where the SDK knowledge lives.
- **Resource is created once (the §C.2 claim, asserted rather than assumed):** resolve an
  `executeInputs` tree referencing one run-scoped resource from four member paths and assert
  `create()` ran once and `dispose()` once — a `resource-registry.test.ts` case.
- **Playwright (`*.pw.tsx`):** the four-member fixture opens combined and renders four rows,
  each labelled with its members; choosing a resource on the `db` row and switching to expanded
  shows it selected in all four member slots; typing into `workspaceId` and reloading restores
  it through `localStorage`; the toggle is absent for a single-member slot.
- **End to end:** open `odin#orchestrate`, fill four controls, Run, and see `list_tasks` return
  real rows — the same goal as `execution-inputs.md`, minus seven redundant controls.

## J. Open questions

1. *Is `type.syntax` equality too strict?* The checker prints a fully resolved intersection for
   `db`; two structurally identical member contexts that reached the checker by different routes
   could conceivably print differently and fail to merge. Not observed in the odin data — all
   four `db` strings are identical — but it would surface as a row that suspiciously appears
   twice, so it is worth logging rather than pre-emptively hunting.
2. *Should `inputLayout` carry a reason?* A hint is currently an unexplained enum, and the panel
   says "Combined" without saying who decided. If a second adapter or a second hinted slot shows
   up, a short string ("the AI SDK keys context per tool") shown on hover would cost little and
   explain a lot.
3. *Where does the "resource narrowed by `for:`" note live?* §E puts it beside the toggle. If
   explicit pinning turns out to be common it probably belongs on the row itself, which needs
   the intersection to record *why* it dropped a candidate rather than just dropping it.
