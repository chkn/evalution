# Proposal: Resource groups and multi-value resources

> **Renamed since shipping.** This document's `needs` is
> now `inputs` and its `values` is now `outputs`; `ResourceValueDefinition` is
> `ResourceOutputDefinition` and `RegisteredSource.valuePath` is `outputPath`. The design below is
> unchanged — read "value" as "output" throughout.

## Context

`specs/execution-inputs.md` §B motivates resources-depending-on-resources with a seeded task:

```ts
export const seededRootTask = resource<TaskId>({
  label: "Freshly seeded root task",
  needs: { db },
  async create({ db }) {
    const id = makeNanoId("tsk_");
    await db.insert(tasks).values({ id, workspaceId: "ws_internal_default" });
    return { value: id };
  },
});
```

That works exactly as far as its return type goes: **one insert, one selectable value**. Two
things it cannot express, both of which the odin panel wants today:

1. **The insert produces more than one interesting value.** `orchestrate` takes `taskId` *and*
   `taskInfo` (`{ title, description }`), and `toolsContext.*.rootTaskId` wants the same id
   again. Those are one seeded row. Under the current shape the only way to supply the title
   alongside the id is a second resource that re-derives it, or typing it in and hoping it
   matches what was inserted — which is the failure mode the resource existed to remove.
2. **There is no room for a library.** A dozen seedable tasks — a simple bug report, a
   deep subtask tree, one with a blocked dependency — are a dozen sibling exports rendering as
   a dozen flat entries in every slot's `<select>`, with nothing saying they are alternatives to
   each other rather than twelve unrelated inputs.

**The ask:** a resource may expose several **named values**, and resources may be organised into
arbitrarily nested **groups**. The picker becomes a nested menu: group `Tasks` → resource
`Task A` → value `Task Name`. A resource exposing one value has no submenu.

```ts
// .evalution/playground/tasks.ts
export const taskA = resource({
  group: "Tasks",
  label: "Task A — simple bug report",
  needs: { db },
  values: { id: "Task ID", title: "Task Name", info: "Task Info" },
  async create({ db }) {
    const id = makeNanoId("tsk_");
    const title = "Fix the flaky login test";
    await db.insert(tasks).values({ id, title, workspaceId: WS });
    return { value: { id, title, info: { title, description: "…" } } };
  },
});
```

---

## A. Values are properties of what `create` already returns

A resource's value stays one value. What is new is that the resource may **name paths into it**
as separately selectable:

```ts
/** One named value a resource exposes as its own entry in the picker. */
export interface ResourceValueDefinition {
  /** Human-readable label, shown as the submenu entry. Defaults to the key. */
  label?: string;
  /** Explicit slot(s) this value fills — same grammar and precedence as a resource's own `for`. */
  for?: string | readonly string[];
}

// on ResourceDefinition, both the dynamic and the static variant:
/** Named values read off the produced value, each selectable on its own. */
values?: Partial<Record<keyof T & string, string | ResourceValueDefinition>>;
```

Four properties of that choice, in order of how load-bearing they are:

- **One `create()` backs every value.** `ResourceRegistry.instantiate` already memoizes by
  resource *object* within a lease, so picking `taskA.id` for one slot and `taskA.title` for
  another creates one task, not two. This is the whole point, and it needs no new machinery —
  only that the several URIs resolve through the same registration.
- **The type comes off `create` as before.** `resourceTypeExpression` already builds
  `Awaited<ReturnType<X["create"]>>["value"]`; a value appends `["id"]`. §D.2 assignability
  matching is unchanged and now decides per value, which is what makes `taskA.id` offered on
  `taskId` and `rootTaskId` while `taskA.info` is offered on `taskInfo`.
- **Exposure is opt-in, and must be.** Auto-exposing every property of an object-typed value
  would enumerate a `Db` handle's 19 members into the menu. `values` is the author saying which
  paths are inputs — the same judgement `label` already is.
- **The keys are checked.** `keyof T & string` catches a typo and follows a rename, for the
  same reason §B preferred an inferred type over a `type: "Db"` string. Where inference is
  unavailable `T` degrades to something whose `keyof` is `string`, and the key is then only
  checked at run time (below), which is the documented checker-less mode.

**Values are top-level keys only, not dotted paths.** `values: { "info.title": … }` would buy
reach at the cost of the `keyof` check, and a resource that wants to expose a nested field can
lift it in `create`'s return, where the author is already writing the object. Revisit only if a
real case appears that lifting cannot serve.

**A missing key is a run-time error naming the URI**, not a silent `undefined`: `create()`
returning an object without `title` fails the run with
`Resource 'tasks.ts#taskA': no value at 'title'`. The checker catches this ahead of time when it
can; the guard is for when it cannot.

**The resource itself stays selectable.** A slot typed as the whole produced object matches the
root entry, exactly as today. Whether the root *and* its values both appear for a given slot is
decided by matching, not by declaring `values` — see §D for what the menu does with a parent
that is itself a valid choice.

## B. Groups are display metadata, never identity

```ts
/** Display path of the group this resource belongs to, `/`-separated for nesting. */
group?: string;   // "Tasks", "Tasks/Regressions"
```

**The URI does not change, and that is the entire design constraint.** Resource references are
persisted in `localStorage` today and recorded into traces for replay under
`execution-inputs.md` §H. If the group path were part of the reference, renaming a group would
silently invalidate every saved selection and make every past trace unreplayable — for a change
that is purely how a menu is drawn. So:

| | grammar | changes when |
| --- | --- | --- |
| URI (identity) | `<module path>#<export>[.<value key>]` | the module moves, the export is renamed, a value key is renamed |
| Group path (display) | `"Tasks/Regressions"` | freely, with no consequence |

Groups **merge across modules** by exact (trimmed) path, so a library of tasks may be split over
as many files as is convenient and still read as one group — the same reasoning that makes
`.evalution/playground/` a directory rather than a file. Ordering is deterministic: modules are
already scanned in sorted order, and within a module exports keep declaration order; a group
sorts at the position of its first member.

**No group is inferred from the file layout.** Deriving `Tasks` from
`.evalution/playground/tasks.ts` is tempting and free, but it would rearrange every existing
panel on upgrade, and it forces a file split on anyone who wants two groups. Absent `group`
means top level, which is today's behaviour exactly.

## C. Server: one flat list of selectable sources

The registry currently maps `uri → RegisteredResource`, and everything downstream — `describe`,
`inScopeFor`, matching, `lease.acquire` — is keyed on that. Values are new leaves on the same
map rather than a nested structure, because every consumer wants the flat form:

```ts
/** One selectable input source: a resource, or one named value read off one. */
export interface RegisteredSource {
  /** `<module>#<export>` or `<module>#<export>.<value key>`. */
  uri: string;
  /** The name the source is matched by: the export name, or the value's key. */
  key: string;
  /** Display label — the resource's, or the value's. */
  label: string;
  /** Group path segments, from `group`. Empty for a top-level source. */
  group: readonly string[];
  /** Explicit slot targeting, from the resource's or the value's `for`. */
  for?: string | readonly string[];
  /** The registration whose `create()` produces this. Its own, for a root source. */
  resource: RegisteredResource;
  /** Path read off the produced value. Empty for a root source. */
  valuePath: readonly string[];
}
```

- `ResourceRegistry.all()` keeps returning **registrations** (roots) — it is what disposal,
  identity mapping and `needs` resolution work over, none of which knows about values.
- `sources()` and `inScopeFor()` return `RegisteredSource[]` — roots plus one entry per declared
  value. This is what `describe()` and the matcher consume.
- `lease.acquire(uri)` parses the fragment: the first `.`-separated segment names the export,
  the rest is the value path. Instantiate the registration (memoized as today), then read the
  path off `instance.value`.

**Receipts, for a value source, are the value itself** when it is plain JSON data
(`isPlainSerializable`, which the registry already has for `describe`), falling back to the
registration's own `receipt`. That is what makes a trace able to say the run used
`tsk_abc123` — the receipt mechanism was designed for exactly this and previously had to be
written by hand.

**`describe()` previews a value the same way it previews a resource**: peek the memoized
instance where one exists (static or server-scoped), read the path, ship it as `ResourceInfo.value`
if plain. A run-scoped value still has nothing to show, and still renders as a chip.

`resolveExecutionInput` is untouched: a `uri` is provider-interpreted and always was.

## D. Wire: three optional fields on `ResourceInfo`

```ts
export interface ResourceInfo {
  uri: string; label: string; scope: ResourceScope; error?: string; value?: unknown;

  /** Group path this source is displayed under, outermost first. Absent = top level. */
  group?: string[];
  /** For a value source: the `uri` of the resource it is read from. */
  parent?: string;
  /** How many values that resource exposes in total, before slot matching narrows them. */
  siblings?: number;
}
```

Still a flat array, because `functionSlots` / `executeSlots` reference sources by `uri` and the
panel filters that array to what matches a slot *before* drawing anything. Shipping a
pre-nested tree would mean pruning a tree per slot instead of filtering a list, and would put a
second shape on the wire that only one component reads.

`parent` is explicit rather than recovered by splitting the `uri` on `.`: the URI grammar is
the provider's, and `execution-inputs.md` §F is deliberate that no client parses it.

`siblings` exists only for the collapse rule in §E, and only the provider can supply it —
after filtering, the panel cannot tell "this resource exposes one value" from "this resource
exposes five and four of them don't fit here", and those two want different labels.

## E. UI: a nested menu, replacing the `<select>`

`SourceRow` renders the source picker as a native `<select>` stretched invisibly over an
icon button. `<select>` supports one level of `<optgroup>` and no nesting at all, so arbitrary
groups end the native control. Both modes go through `SourceRow` already (that is why
`combined-execute-inputs.md` extracted it), so one component swap covers expanded and combined.

**`source-tree.ts` (new, pure).** `buildSourceTree(resources, matchedUris)` → `SourceNode[]`,
where a node is a group, a resource, or a value. It takes the *unfiltered* list plus the matched
set so it can apply:

- **Prune.** Drop anything with no matching descendant. A group whose tasks all fail to fit the
  slot does not appear.
- **Collapse.** A container with exactly one selectable descendant and no selectable identity of
  its own *becomes* that descendant. This is the rule the ask names — "resources that only
  return one value don't show a submenu" — stated so it also covers a group pruned down to one
  member, and a five-value resource of which one fits this slot.
- **Label a collapsed entry for what it actually picks.** A resource with `siblings === 1`
  collapses to the resource's own label (the value *is* the resource, and repeating the value's
  name is noise). One narrowed by matching collapses to `Task A — Task Name`, because the
  submenu that would have disambiguated it is gone. Every collapsed entry carries the full
  breadcrumb as its `title`.
- **A parent that is itself selectable is the first entry in its own submenu**, labelled with
  the resource's label. Clicking the parent row opens the submenu rather than choosing it — a
  menu row that both opens and selects is the one interaction users reliably get wrong.

Pure, no React, unit-tested in `vitest` — the same split `combined-inputs.ts` established.

**`SourcePicker.tsx` (new).** A portal-rendered menu with flyout submenus.
`ModelPicker.tsx` is the precedent for the mechanics — fixed positioning off the trigger's
`getBoundingClientRect`, outside-`mousedown` and `Escape` to close, reposition on capture-phase
scroll and resize — and those ~40 lines are worth extracting to
`use-anchored-popover.ts` and sharing rather than copying. A portal is not optional here: the
execute panel is a scrolling sidebar, so an in-flow menu would clip.

```
[ ⋯ ]
 ├ Custom                        ← editable slots only; absent for `opaque`
 ├ Local D1 (.wrangler state)    ← ungrouped, single-value
 ├ Tasks                      ▸  → Task A — simple bug report  ▸ → Task ID
 │                                 Task B — blocked subtree    ▸    Task Name
 └ Freshly seeded root task                                         Task Info
```

- **Keyboard.** `↑`/`↓` within a level, `→`/`Enter` opens a submenu, `←`/`Escape` returns to the
  parent, `Escape` at the root closes. `role="menu"` / `menuitem`, `aria-haspopup` and
  `aria-expanded` on submenu rows; the trigger keeps its `aria-label="Source for {name}"`.
- **Filter.** A text input appears when the tree holds ≥ 8 selectable entries; matches render as
  a flat list with breadcrumbs. A library of tasks is the case this exists for.
- **Everything the `<select>` did survives**: the "Custom" entry for editable slots, the
  "Pick a resource…" placeholder for `opaque`, and the stale-URI entry that keeps a renamed or
  deleted resource visible and selected rather than silently swapping in an editor.
- **Submenu flyouts flip** to the left of the parent when they would overflow the viewport;
  depth is arbitrary, so the flip has to be per level, not per menu.

**Combined mode needs no changes.** `CombinedInputEditor` intersects matches across member paths
and hands the result to `SourceRow`; value URIs are strings like any other. Picking
`tasks.ts#taskA.id` once for a combined `rootTaskId` row fans out to every member — and the
lease still creates one task, which is the §C.2 claim in that spec, now with more ways to reach it.

## F. Alternatives considered

**A `group()` export kind** — `export const tasks = group("Tasks", { taskA, taskB })` — reusing
the open export surface of `execution-inputs.md` §B. It reads better than a repeated string and
has somewhere to hang group-level metadata. Rejected for v1 on identity: a resource reachable
only through a group has no export name, so its URI has to become `#tasks.taskA`, which puts the
grouping back into the reference and re-creates precisely the breakage §B avoids. Keeping the
resources exported *and* listing them in a group means two places to edit and a loader that must
not double-register. It stays available later as another recognised tag, with `group` on the
resource as the fallback for anything the helper does not cover — and adding it then changes no
URI.

**Declaring values as a separate export or a `select()` accessor.** Both re-declare a type the
checker can already read off `create`, which is the argument §B made against a `type:` string.

**Auto-exposing every property of an object-typed value.** Zero ceremony, and wrong for the
motivating type: a `Db` slot would gain a submenu of 19 Drizzle members. Opacity (§A of the
parent plan) decides whether a type has an *editor*; it has nothing to say about which paths
are meaningful inputs, and inferring that from structure is not something the checker can do.

**Deriving groups from the module path.** Free, and it would organise `.evalution/playground/`
automatically — but it rearranges existing panels on upgrade and forces a file split per group.

**Keeping the native `<select>` with `<optgroup>` for one level.** Cheaper, keeps the existing
PW selectors, and covers "Tasks → Task A" but not "Task A → Task ID" — the flattened
`Task A — Task ID` entries under one `<optgroup>` would grow multiplicatively with a library.

## G. Phasing

1. **Values, server-side.** `values` on the definition, the URI grammar, `RegisteredSource`,
   `lease.acquire` path resolution, receipts, `describe` previews, `resourceTypeExpression`.
   Visible immediately as flat `Task A — Task ID` entries in today's `<select>` — useful on its
   own, and it makes the seeded-task case work before any UI lands.
2. **Groups on the wire.** `group` on the definition → `ResourceInfo.group`, plus `parent` and
   `siblings`. Still flat in the UI; nothing renders differently yet.
3. **`source-tree.ts` + `SourcePicker`.** The nested menu, the collapse rules, the `<select>`
   retired, `use-anchored-popover` extracted.
4. **Polish.** Filter input, keyboard traversal, flyout edge-flipping, sub-value previews.

Steps 1–2 are what odin's `taskInfo` slot actually needs; step 3 is what a library of tasks
needs.

## H. Files

- `src/prompt/playground/resource.ts` — `ResourceValueDefinition`; `values` and `group` on both
  definition variants; doc comments for `npm run docs`.
- `src/prompt/playground/resource-registry.ts` — `RegisteredSource`, `sources()`,
  `inScopeFor` returning sources, value-path parsing in `lease.acquire`, per-value receipts,
  `describe` previewing a path.
- `src/prompt/file/file-prompt-provider.ts` — `resourceTypeExpression` appends the value path;
  `resolveInputSources` maps sources (not registrations) to `InputSource`s, carrying each
  value's own `for` and `key`.
- `src/shared/types.ts` — `ResourceInfo.group` / `.parent` / `.siblings`.
- `src/client/components/source-tree.ts` *(new)* — `SourceNode`, `buildSourceTree`, prune and
  collapse; pure.
- `src/client/components/SourcePicker.tsx` *(new)* — the nested menu.
- `src/client/components/use-anchored-popover.ts` *(new)* — extracted from `ModelPicker`;
  `ModelPicker` migrated to it in the same change, since the behaviour is identical.
- `src/client/components/SourceRow.tsx` — `<select>` → `SourcePicker`.
- `src/client/styles.css` — menu, submenu, breadcrumb, filter row.
- `src/client/components/__fixtures__/executionFixtures.ts` — a grouped, multi-value fixture
  beside the existing ones.
- `docs/` — the resource authoring guide gains `values` and `group`.

## I. Verification

- **Unit, registry (`vitest`, `MemoryFileProvider`):** a resource with three `values` registers
  four sources (root + three); two values of one resource acquired in one lease run `create()`
  **once** and dispose once; a value URI naming a key `create()` did not return fails with a
  message naming the resource and the key; a value source's receipt is the value itself when
  plain and the registration's `receipt` when not; a static `value` resource with `values`
  previews each through `describe`; `group` never appears in any `uri`.
- **Unit, matching:** `taskA.id` is offered on a `TaskId` slot and `taskA.info` on a
  `taskInfo` slot, from one resource, via assignability; a value's `for` pins only that value
  and does not pin its siblings; with no checker, name matching uses the value key, not the
  export name.
- **Unit, `source-tree.ts`:** nested groups nest; a group with no matching descendant is
  pruned; a resource with `siblings === 1` collapses to its own label; a five-value resource
  narrowed to one collapses to `Resource — Value`; a resource that is itself selectable appears
  as the first entry of its own submenu; two modules declaring `group: "Tasks"` merge into one
  node; ordering is stable across two calls.
- **Back-compat:** a stored selection of `db.ts#db` made before this change still resolves and
  still renders selected — the regression that would catch grouping leaking into identity.
- **Playwright (`*.pw.tsx`):** the grouped fixture opens a menu, not a `<select>`; hovering
  `Tasks` opens a submenu and hovering `Task A` opens its values; choosing `Task ID` shows the
  chip and round-trips through `localStorage`; a single-value resource has no submenu; keyboard
  traversal reaches a depth-3 entry and `←` returns; the menu is not clipped by the sidebar's
  scroll container.
- **End to end:** open `odin#orchestrate`, pick `Tasks → Task A → Task ID` for `taskId` and
  `Tasks → Task A → Task Info` for `taskInfo`, Run, and see one seeded task backing both.

## J. Open questions

1. *Does `keyof T & string` actually bind?* `T` is inferred from `create`'s return within the
   same object literal that declares `values`. Inference order should resolve `create` first,
   but context-sensitive cases can leave `T` unresolved and silently widen the keys to `string`.
   Verify against the real odin playground module early in step 1; if it misbehaves, the
   fallback is `Record<string, …>` — which also re-opens dotted value paths, since the `keyof`
   check was the only reason to refuse them.
2. *N×M growth in assignability matching.* Sources go from one per resource to one per value.
   A dozen tasks × four values is 48 sources against odin's ~40 slots — still small, but the
   cost is now driven by an author's library size rather than by their resource count. Worth a
   measurement in step 1 rather than an assumption.
3. *Should the collapse rule apply to a group of one at the top level?* Collapsing `Tasks` when
   only one task fits keeps the menu short but hides the fact that a library exists and was
   filtered. The breadcrumb `title` mitigates it; if it reads badly, the alternative is to
   collapse resources but never groups.
4. *Receipt size.* A value receipt is the value, and a value may be a large object. A cap
   (record a truncated summary past N bytes) is probably wanted before traces are persisted to
   a DB, but it is not needed to ship this.
