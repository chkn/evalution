# Proposal: Prompt versions and variations

## Context

A trace can say which prompt it ran (`PromptID.id`) and with what inputs (`functionInputs`,
`executeInputs`), but not **which content** of that prompt. The file it ran from is whatever is on
disk now. `FilePromptProvider.parameterSnapshot` papers over the narrowest half of this by writing
the parameter signature down at run time, and its comment states the stance this spec reverses:
"git is the version — the playground has no business checking out old commits".

Two things now need more than that:

- **Evals compare prompts** (`specs/evals.md`). An eval result is only meaningful next to the
  prompt it measured, and a comparison is only meaningful if both sides can be named, reopened,
  and run again.
- **Editing writes straight to the file.** Every keystroke in the playground is a
  read-modify-write of the user's source (`updatePromptProperties` → `mutateFile`). Trying an idea
  means changing the code, and there's no way to hold two ideas at once.

**The ask:** two complementary features, first-class on `PromptProvider`.

- A **version** is a saved checkpoint of the state of the world: for a git project, a commit.
- A **variation** is a targeted patch — a `NormalizedPromptUpdates` — on top of a base version.

`FilePromptProvider` delegates to adapters for both: a git versioning adapter (the default when a
`.git` directory is found) and a Turso-backed variation store.

Revised 2026-09-29: **uncommitted changes are never versioned.** An earlier draft snapshotted a
dirty working tree into unreferenced commits (and, without git, stored prompt files as blobs) so
every run and every WIP had an exact base. Nothing read those snapshots back beyond the prompt's own
file, and the cost was a `git add -A` per edit session and run plus refs that piled up. Now a
version is a commit and nothing else. A variation records the field values it overwrote, which is
all its three-way merge needs (§F). A run on a dirty tree records no version, and evals warn about
it (`specs/evals.md` §C).

Decided up front (2026-09-25):

- **v1 runs head and variations on head only.** Older versions can be *viewed*, and a variation
  made against one can be applied to head, but nothing runs against an old version's code. Running
  old versions (worktrees) is later work (§J).
- **The public API may break.** `PromptProvider` is reshaped around a `PromptRef` (§B) rather than
  growing a `version?`/`variation?` parameter on every method.
- **Editing goes through a work-in-progress variation by default** (§G). Writing the file becomes
  an explicit Save.

### Where this differs from the original ask

The ask this spec answers is in `v-and-v-prompt.txt`. Four deliberate departures, each argued in
its section:

1. **Uncommitted changes are neither a version nor a variation** (§C). Most uncommitted changes
   can't be expressed as `NormalizedPromptUpdates` — an edit to `stopWhen`, to a tool, to
   `tools/index.ts` — so they can't become a variation. Capturing them as versions costs more than
   it has bought so far (see the revision note above). They're simply the working tree:
   variations apply on top of it, and a run on it records no version. Anyone who needs a
   reproducible run commits first.
2. **"Apply to head" is a three-way merge, not a patch application** (§F). Updates replace whole
   fields, so applying one blindly over a head that also changed that field silently discards
   head's change.
3. **No garbage collection, so no foreign keys from traces, so the trace DB stays put** (§E). A
   cross-database FK only holds while one database holds both tables, and the trace and variation
   providers are separately pluggable. Variation rows are small and deduplicated; nothing needs
   collecting yet.
4. **No worktrees in v1** (§J). Viewing an old version needs only `git show`.

---

## A. Vocabulary

| term | meaning |
| --- | --- |
| **head** | The working tree: what is on disk now. What runs, and what the user edits in their IDE. |
| **version** | An immutable, reproducible state of the world, named by an opaque id. For git: a commit (§C). |
| **variation** | An immutable `NormalizedPromptUpdates` for one prompt, plus the field values it overwrote. It applies to the working tree. Its base commit, when it has one, is where it can also be shown as made (§E). |
| **WIP variation** | The one mutable variation of head per prompt, or per (prompt, old version): the playground's unsaved edits (§G). |
| **named variation** | A variation someone gave a name to. Names point at variations; variations don't carry names. |
| **rebase** | Re-expressing a variation against a different target (usually the working tree), by three-way merge (§F). |
| **save** | Rebase onto head, then write the result into the file. |

"Head" is the working tree rather than `HEAD` the commit because it's what executes: a prompt that
imports `../../tools` gets the tools on disk, committed or not.

## B. `PromptRef`: one reference type through the API

```ts
/** Which prompt, in which state. */
export type PromptRef =
  /** Head: the prompt as it is on disk now. */
  | { promptId: string }
  /** The prompt as it was at a saved version. Read-only in v1 unless it equals head. */
  | { promptId: string; version: VersionId }
  /** A variation, applied to its base commit (or to the working tree, without one). */
  | { promptId: string; variation: VariationId };
```

A variation already knows its base, so `{ variation }` is complete. There is deliberately no
`{ version, variation }` pair meaning "this variation on some other version", because that's not a
reference to anything that exists. It's a rebase, which produces a new variation (§F) with its own
id.

`promptId` stays on every arm even though a variation also records it, so routing (`/api/prompts/
:providerId/:id`) and the prompt registry keep working unchanged.

### The reshaped provider

```ts
export interface PromptProvider<TPrompt extends NormalizedPrompt = NormalizedPrompt> {
  readonly id: string;
  // … displayName, description, icon unchanged

  getAllPrompts(): Promise<TPrompt[]>;                       // head only
  getPrompt(ref: PromptRef | string): Promise<TPrompt | null>;

  /**
   * Applies updates to the prompt `ref` names, and returns where they landed.
   * On a provider with variations, this never writes the source directly: it
   * updates (or creates) the WIP variation for `ref`'s base (§G). Without
   * variations, it writes the source as today.
   */
  updatePromptProperties?(
    ref: PromptRef | string,
    updates: NormalizedPromptUpdates,
  ): Promise<{ prompt: TPrompt; ref: PromptRef }>;

  execute(ref: PromptRef | string, params: any[], options?: ExecuteOptions): Promise<ExecuteResult>;
  resolveInputs?(ref: PromptRef | string, inputs: …): Promise<ResolvedPromptInputs>;

  /** Present when this provider can name states of the world. */
  readonly versions?: PromptVersions;
  /** Present when this provider can hold edits apart from the source. */
  readonly variations?: PromptVariations;

  // … setupTraceIngestion, getModelDefinition, getModelParameters, watch,
  //   addPrompt, renamePrompt unchanged
}
```

- **`string` is still accepted** wherever a ref is, meaning head. Every provider that has no notion
  of versions keeps its current shape, and most call sites don't change.
- **Capabilities are objects, not a spray of optional methods.** `provider.variations?.save(id)`
  reads as what it is, and a provider either has the whole capability or none of it.
- **`execute` returns what it ran** — `{ version?, variation? }` — because a run on a clean tree
  records the commit (§D) and running a variation may first rebase it (§H). The caller records it
  and the eval runner needs it.

```ts
export interface PromptVersions {
  /** The commit checked out, and whether the working tree is clean. */
  head(): Promise<{ commit?: VersionInfo; clean: boolean }>;
  /**
   * Versions that changed this prompt's file, newest first — what the version
   * selector lists (§I). Never every version: see §C.3.
   */
  history(promptId: string, options?: { limit?: number; before?: VersionId }): Promise<VersionInfo[]>;
  get(id: VersionId): Promise<VersionInfo | undefined>;
}

export interface VersionInfo {
  id: VersionId;
  /** Commit subject. */
  message?: string;
  author?: string;
  time: number;
}

export interface PromptVariations {
  get(id: VariationId): Promise<VariationInfo | undefined>;
  /** Named variations of a prompt, plus its WIP ones. */
  list(promptId: string): Promise<VariationInfo[]>;
  /** Names a variation. A name is unique per prompt, and naming again moves it. */
  name(id: VariationId, name: string): Promise<VariationInfo>;
  unname(promptId: string, name: string): Promise<void>;
  /** Re-expresses `id` against `onto` (default: head) as a new frozen variation. See §F. */
  rebase(id: VariationId, onto?: VersionId): Promise<RebaseResult>;
  /**
   * Brings `id`'s changes into the head WIP: rebases onto head, then merges
   * into the WIP if one exists. Returns the WIP. See §G.
   */
  openOnHead(id: VariationId): Promise<RebaseResult>;
  /** Rebases a WIP onto head, writes it into the source, and deletes it. See §G. */
  save(wipId: VariationId): Promise<RebaseResult>;
  /** Drops a WIP variation. Frozen variations are never deleted in v1 (§E). */
  discard(id: VariationId): Promise<void>;
}

export interface VariationInfo {
  id: VariationId;
  promptId: string;
  /** The commit it was made against, if the prompt's file had nothing uncommitted (§E). */
  base?: VersionId;
  updates: NormalizedPromptUpdates;
  wip: boolean;
  names: string[];
  createdAt: number;
  updatedAt: number;
}

export type RebaseResult =
  | { ok: true; variation: VariationInfo }
  | { ok: false; conflicts: VariationConflict[] };
```

`NormalizedPrompt` gains the ref it was read at, and whether it may be edited, so the client never
has to work either out:

```ts
interface NormalizedPrompt {
  // … existing fields
  /** Where this prompt was read from. */
  ref?: PromptRef;
  /** The base version, when {@link ref} is a version or variation. */
  version?: VersionInfo;
  /** True when a WIP variation exists for this prompt at head: the dirty indicator. */
  dirty?: boolean;
}
```

## C. The git versioning adapter

`FilePromptProvider` takes a `versioning?: VersioningAdapter` option. When it's omitted and a
`.git` directory is found above `rootDir`, it builds a `GitVersioning`. Otherwise there are no
versions: variations still work, since they apply to the working tree (§E), but nothing records or
reopens a version.

```ts
export interface VersioningAdapter {
  readonly id: string;
  /** The commit checked out, and whether the working tree has changes on top. */
  head(): Promise<{ commit?: VersionInfo; clean: boolean }>;
  /** A file's content at a version, or undefined if it didn't exist there. */
  readFile(version: VersionId, relativePath: string): Promise<string | undefined>;
  history(relativePath: string, options?: { limit?: number; before?: VersionId }): Promise<VersionInfo[]>;
  get(id: VersionId): Promise<VersionInfo | undefined>;
}
```

The adapter speaks paths; `FilePromptProvider` maps prompt ids to paths. It shells out to `git`
through `execFile`. There's no library dependency, and a missing `git` binary is reported at
construction as "versioning unavailable" rather than failing later.

- **`head()`** is `rev-parse HEAD` plus `status --porcelain`, run with `GIT_OPTIONAL_LOCKS=0` so
  it never rewrites the user's index. Untracked files make the tree dirty (a new tool module
  changes what a run does as surely as an edited one). Ignored files don't. An unborn `HEAD` has
  no commit and is never clean.
- **`readFile()`** is `git cat-file blob <commit>:<path>`.
- **`history()`** is `git log -- <path>` over `HEAD`'s ancestry: only commits that touched the
  prompt's file, since the version selector is for choosing *this prompt's* past states.
- **Uncommitted changes are never recorded.** Nothing is written to the repository: no temporary
  index, no objects, no refs.

## D. Recording versions on traces

`PromptID` gains two fields:

```ts
interface PromptID {
  // … existing fields
  /** The commit the run executed against, when the working tree was clean. */
  version?: string;
  /** The variation applied on top, if any. */
  variation?: string;
}
```

`FilePromptProvider.execute` fills both through the existing `identity` passed to
`SDKAdapter.executeConfig`, and they travel as `evalution.prompt.version` and
`evalution.prompt.variation` beside `evalution.prompt.id` in `otel-attributes.ts`.

**A version is recorded only when the working tree is clean**, because only then is the commit what
ran. A run on a dirty tree records no version: claiming the commit would be a lie, and there's no
other name for what ran. The trace still records its variation, and its `parameterSnapshot`. It's
the caller's job to warn where reproducibility matters: the eval runner does (`specs/evals.md`
§C), and the playground doesn't, since most runs there are exploratory.

A production trace has neither field unless the app sets them. Stamping a deploy's commit is a
natural later addition and shares the field.

`parameterSnapshot` stays. It's redundant whenever the recorded version can be read back, but a
run on a dirty tree records none.

## E. The variation store

A variation is three things:

- **`updates`:** the fields it sets.
- **`baseValues`:** the prompt's values for those same fields, as they were when it was made (the
  working tree's, or the old version's). This is the base of the three-way merge that carries it
  onto a working tree that has changed since (§F). No copy of the base file is needed.
- **`base`:** the commit it was made against, when there is one. It's set when the prompt's file had
  nothing uncommitted, so the commit plus the updates reproduce exactly what the user saw. That is
  what viewing a variation "as made" shows, and what running old base plus variation will need
  (§J). Otherwise it's absent, and the variation is shown on the working tree. A head WIP has no
  base: it's the working tree's unsaved edits.

```ts
export interface VariationStore {
  get(id: VariationId): Promise<StoredVariation | undefined>;
  /** Inserts, or returns the existing row with the same content. */
  intern(v: { promptId: string; base?: VersionId; updates: NormalizedPromptUpdates; baseValues: FieldValues }): Promise<StoredVariation>;
  getWip(promptId: string, oldVersion: VersionId): Promise<StoredVariation | undefined>;
  getHeadWip(promptId: string): Promise<StoredVariation | undefined>;
  putWip(v: NewWip): Promise<StoredVariation>;
  updateWip(id: VariationId, changes: { updates?, baseValues?, pending?, originName? }): Promise<StoredVariation>;
  deleteWip(id: VariationId): Promise<void>;
  list(promptId: string): Promise<StoredVariation[]>;
  name(id: VariationId, promptId: string, name: string): Promise<void>;
  unname(promptId: string, name: string): Promise<void>;
}
```

`TursoVariationStore` is the one implementation. It lives in `.evalution/variations/variations.db`,
a self-ignoring directory like `.evalution/traces/` (`mkdirSelfIgnoring`), and follows the trace
and dataset DBs' migration pattern.

```
variations
  id            TEXT PRIMARY KEY          -- "var_" + nanoid
  prompt_id     TEXT NOT NULL             -- as of the base
  global_id     TEXT                      -- the prompt's prompts() id, when it has one
  base_version  TEXT NOT NULL DEFAULT ''  -- '' for none, so it takes part in the indexes
  updates       TEXT NOT NULL             -- canonical JSON (§E.1)
  base_values   TEXT NOT NULL             -- canonical JSON
  wip           INTEGER NOT NULL DEFAULT 0
  on_head       INTEGER NOT NULL DEFAULT 0
  origin_name   TEXT                      -- a WIP opened from a named variation
  pending       TEXT                      -- a WIP's unresolved conflicts (§G)
  created_at    REAL NOT NULL
  updated_at    REAL NOT NULL
  UNIQUE (prompt_id, base_version, updates, base_values) WHERE wip = 0
  UNIQUE (prompt_id, base_version)  WHERE wip = 1 AND on_head = 0
  UNIQUE (prompt_id)                WHERE wip = 1 AND on_head = 1

variation_names
  prompt_id     TEXT NOT NULL
  name          TEXT NOT NULL
  variation_id  TEXT NOT NULL REFERENCES variations(id)
  created_at    REAL NOT NULL
  PRIMARY KEY (prompt_id, name)
```

- **Uniqueness covers the prompt, the base and the overwritten values, not the updates alone.**
  "Set `system` to X" means different things for different prompts, and over different values it
  merges differently.
- **`global_id` is recorded** so a rebase can find the prompt at head after a file move or an
  export rename (§F).
- **At most one head WIP per prompt, and one WIP per (prompt, old version)**, enforced by the
  partial unique indexes.
- **Nothing is garbage-collected in v1.** Frozen rows are only minted when something runs or gets a
  name (§G), and they dedupe, so growth is bounded by distinct runs. Traces and eval results
  reference variations by id as plain data, the same way they reference prompts. A variation whose
  row is gone is reported as unresolvable, just as a deleted prompt is. If collection is ever
  needed, the rule is "unnamed, not WIP, and referenced by no trace or eval run". That rule works
  across databases through a query to each provider rather than an FK.

### E.1 Canonical updates

Two update sets that mean the same thing must produce the same bytes, or dedup fails and "is it
dirty?" lies:

- **Merged.** Successive edits fold into one `NormalizedPromptUpdates`: later fields win,
  `modelParameters` merges per key, and `null` (remove) is kept as a value.
- **Minimized against the base.** A field equal to the base's value is dropped, so edit-then-undo
  leaves an empty WIP. An empty WIP is deleted rather than stored, which is what clears the dirty
  indicator.
- **Serialized with sorted keys** and no insignificant whitespace.

This lives in one pure function, `canonicalizeUpdates(base: NormalizedPrompt, updates)`, next to
`applyOptimisticUpdates`, which it resembles.

## F. Rebase: three-way merge per field

A variation is "set these fields to these values". Rebasing it onto target `T` (the working tree,
unless an old version is named) compares three values for each field it sets. The base's value
`B[f]` is the one it recorded overwriting:

| `T[f]` vs `B[f]` | `T[f]` vs `V[f]` | result |
| --- | --- | --- |
| equal | — | take `V[f]` (only the variation changed it) |
| differs | equal | drop `f` (both made the same change; nothing left to apply) |
| differs | differs | **conflict** |

- **Fields are the normalized ones**: `model`, `system`, `messages`, each `modelParameters` key,
  `state`, and `questions`. `messages` is one field. A per-message merge is a later refinement,
  and a line-level text merge inside `system` is §K.4.
- **`B[f]` is the variation's `baseValues[f]`.** A merge only ever looks at the fields the updates
  set, so those values are all of the base it needs. It needs no copy of the base file, and there's
  no version of a dirty tree to keep.
- **A clean rebase re-records the base values** as `T`'s. A frozen variation rebases into a new
  one (via `intern`, so rebasing twice onto the same head is free). A WIP is updated in place. A
  rebase whose result is empty is `ok` with empty updates, and means "already applied".
- **The prompt has to exist at the target.** It's found by `prompt_id`, then by `global_id`.
  Neither matching is a conflict on the pseudo-field `prompt`.
- **Conflicts carry all three values** so the UI can show them side by side and let the user pick:

```ts
interface VariationConflict {
  field: string;               // "system", "modelParameters.temperature", "prompt"
  base: unknown; target: unknown; variation: unknown;
}
```

Parsing an old version's content (to show it, or to rebase onto it) resolves its imports against
head's code, because that's the only code on disk (§J). The normalized fields are read
syntactically, so for merging this is exact. For display it can mislabel a type that changed since,
which is why an old version opens read-only with a banner (§I).

## G. Editing: the WIP variation

With variations available, `updatePromptProperties` never writes the file:

1. **The first edit** at `{ promptId }` (head) creates the head WIP with the canonicalized update
   and the working tree's values for its fields, and returns `ref: { variation: wipId }`. The
   client switches to that ref. Uncommitted changes to the file need no special handling: they're
   simply part of the working tree the WIP applies to.
2. **Later edits** to the WIP merge and re-canonicalize in place, against the working tree. A WIP
   that canonicalizes to empty is deleted, and the prompt is clean again.
3. **Run** carries the WIP onto the working tree (a no-op when nothing changed) and `intern`s the
   result as a frozen row, with the checked-out commit as its base when the file is clean. The WIP
   carries on. Every trace points at an immutable variation, and running unchanged edits twice
   reuses one row.
4. **Save** calls `variations.save(wipId)`. It rebases onto the working tree, writes the result
   through today's pipeline (`denormalizeUpdates` → `fileType.updateProperty` inside `mutateFile`),
   and deletes the WIP. This is the only path that writes a prompt file.
5. **Discard** deletes the WIP.

**External edits rebase the WIP.** On a watcher event, or lazily on the next read, the provider
compares the working tree's values for the WIP's fields with the WIP's `baseValues`. An edit to
other fields changes nothing. An edit to one of its fields rebases it (§F). A clean rebase is
silent. A conflicted one records the conflicts as `pending` (with the working tree's values at
that moment, which the resolved WIP will be based on) and the editor shows them (§I). The WIP
can't run until they're resolved, because running would silently drop either the IDE edit or the
playground edit.

**Editing an old version** follows the same rules against a different base: editing
`{ version: v }` creates or updates the WIP for (prompt, `v`).

**A frozen variation is read-only.** Editing `{ variation: x }` is rejected, and the editor shows
`x` read-only under a banner whose one action is **Open on working tree**. Editing it in place
would have to pick a WIP for the edit to land in, and at head that means merging `x` over any
unsaved edits there, silently, on the first keystroke. Opening on the working tree makes that
merge an explicit step that reports conflicts (below). A WIP opened from a named `x` remembers the
name, and "Save as variation" moves that name to the new frozen row. Editing a variation *without*
bringing it to head (say, a WIP of its own) is left open for later.

**Open on working tree is the only way to bring a variation to head.** `openOnHead(x)` rebases `x`
onto the working tree (§F). If there's no head WIP, the result becomes the WIP. If there is
one, the rebased updates merge on top of it field by field, and any field both set to different
values becomes a conflict in the same conflict bar, labelled *unsaved edits* vs *x*. Writing the
file is then an ordinary Save. There's no separate "apply" action, because it would be exactly
open-then-save with the review step removed. The review step is where a rebase that went through
cleanly but did something surprising gets caught.

**Autosave** is a per-user toggle (in `localStorage`, like the panel's other preferences) that
calls Save after each debounced edit. It restores today's write-through behaviour for anyone who
wants it, using the same machinery.

## H. Materializing a variation without touching disk

To display or run a variation, its patched source has to exist somewhere a parse and an `import`
can see. That somewhere must behave as if it's at the real path, or `import … from "../../tools"`
resolves against the wrong directory.

**Parse and edit through an overlay.** `OverlayFileProvider` wraps the provider's `FileProvider`.
`readFile` and `writeFile` for overlaid paths hit an in-memory map, and everything else passes
through. Materialization writes the base content (`versioning.readFile(base, path)`, or the working
tree's content for a variation without a base) into the overlay, then runs the **existing** edit pipeline against it: `denormalizeUpdates` and
`fileType.updateProperty`/`addProperty`/`removeProperty`. So there's no second implementation of
"apply updates to source". `prompt-program.ts` already reads prompt sources through the
`FileProvider`, so the checker sees the patched text. The result is cached by variation id, its last
change, and its base: the commit, or the hash of the working tree's content.

**Import through a load hook.** `OverlayFileProvider.import(path)` registers the patched source
under its SHA-256 and imports `file:///…/odin.prompt.ts?evalution-src=<sha256>`. A `load` hook
registered with `module.registerHooks` (as `config-loader-hooks.ts` already does) answers that URL
with `{ format: "module-typescript", source, shortCircuit: true }`. Node resolves the module's
relative imports against the URL's path, so they land where the real file's would. The engines
floor (22.18) has type stripping on by default. The query also acts as the cache-buster, so no
mtime is needed. A host whose transform pipeline refuses query strings (the case
`LocalFileProvider` already detects) can't run variations. The error says so, rather than silently
running head.

**Running a variation runs it on head.** In v1, `execute({ variation })` first rebases the
variation onto the working tree (usually a no-op `intern` hit) and runs the result. The
returned `ExecuteResult` and the trace record the rebased id. A conflicted rebase refuses to run
and returns the conflicts.

## I. UI

- **Prompt header:** a ref chip, "Working tree · ● unsaved", beside the prompt name. It opens a
  menu listing the WIP, named variations, and the versions that changed this prompt's file
  (`versions.history`, §C.3). The dirty dot also appears in the prompt list.
- **Save / Discard** buttons, and ⌘S, appear while a WIP exists. A conflicted WIP replaces them with
  a conflict bar. Each conflicted field shows base, head, and yours, and offers "keep head" or
  "keep mine" per field.
- **"Save as variation…"** names the current WIP (it interns it, then names the frozen row).
- **Opening an old version, or a frozen variation,** shows a banner: "Viewing <name> on <short
  sha> · <message>", then why it can't be edited or run from here ("Saved variations are
  read-only.", "Running is only available on the working tree."). One action: **Open on working
  tree** (`openOnHead`, §G).
- **Trace → Open prompt** opens `{ variation }` when the trace recorded one, otherwise
  `{ version }`, otherwise head. When that version's copy of the file is what's on disk, it opens
  head, so the common case of opening a trace you just ran lands somewhere editable.
- **Trace list:** a "Version" column (the short sha, or `—` for a run on a dirty tree) and a
  variation name column, both off by default.

**Wire.** Refs travel as query parameters on the existing prompt routes: `?version=` or
`?variation=`. New routes:

| route | does |
| --- | --- |
| `GET /api/prompts/:p/:id/versions` | `versions.history` |
| `GET /api/prompts/:p/:id/variations` | `variations.list` |
| `POST /api/variations/:p/:vid/{open-on-head,save,discard,rebase}` | the matching method |
| `PUT /api/variations/:p/:vid/name` / `DELETE …/name/:name` | name / unname |

`POST /update` responds with `{ prompt, ref }`, and the client adopts `ref`. Prompt change events
gain `ref?`, so a WIP change or a rebase-on-external-edit reaches other open tabs.

## J. Later: running old versions

Deferred by decision. What running old versions will need, so v1 doesn't paint over it:

- **A worktree per version** under `.evalution/worktrees/<version>`, made with
  `git worktree add --detach`. It has no `node_modules`, and in a monorepo there are several.
  Symlinking the main checkout's is only correct while dependencies haven't changed. Installing is
  correct and slow.
- **Everything loads from the worktree**, including resources. Mixing worlds breaks on identity:
  asgard's tools validate `db instanceof DbClass`, which fails for a `Db` built by head's copy of
  the class. Checks (`specs/evals.md`) would still come from head, because the user wants the latest
  eval. They'd run against a world that might have an older schema, and would report `error` when
  it doesn't fit.
- **`PromptRef` needs no change.** `{ version }` and `{ variation }` on an old base simply become
  runnable.

## K. Open questions

1. *File vs. prompt granularity in history.* §C.3 filters by the prompt's *file*, so a commit that
   only changes a sibling prompt in the same file is still listed. Filtering by the prompt's own
   normalized fields would mean parsing every listed version. Worth it only if multi-prompt files
   turn out to be common.
2. *Capturing uncommitted changes.* If reproducible runs on a dirty tree turn out to matter (evals
   are the likely case), snapshot the tree once per eval run, not per edit, into a commit kept alive
   by a ref. The earlier draft of §C did this for every run and edit.
3. *Text merge.* `system` is the field most likely to conflict, and a line-level diff3 would resolve
   most of those. `system` is a `PropValue` that may hold interpolation tokens, so the merge has to
   treat each token as an atom.
4. *Production traces.* An app could stamp its deploy's commit as `evalution.prompt.version`, which
   would make a production trace openable at the exact prompt it ran. It needs an SDK option, and
   a way to tell that a commit exists locally.

## L. Phasing

1. **Versions on traces.** The `VersioningAdapter` interface, `GitVersioning` (`head`,
   `readFile`, `history`, `get`), `PromptID.version`, and the OTel attribute. Every run on a clean
   tree records a version. Nothing is visible in the UI yet except a trace column.
2. **`PromptRef` and read-only refs.** The reshaped `PromptProvider`, `OverlayFileProvider`, and
   `getPrompt({ version })`. Open prompt from a trace, with the old-version banner.
3. **Variations and WIP editing.** `TursoVariationStore`, canonicalization, rebase, the load hook,
   `execute({ variation })`, WIP editing, Save, Discard, rebase on external edit, the conflict bar,
   and the autosave toggle.
4. **Named variations.** Naming, the ref menu, "Save as variation", and "Open on working tree".

Step 3 is the one users feel. Steps 1 and 2 are prerequisites that ship independently, and step 1
alone is enough for `specs/evals.md` to record what an eval run measured.

## M. Files

- `src/prompt/prompt-provider.ts`: `PromptRef`, `PromptVersions`, `PromptVariations`,
  `ExecuteResult`, and the reshaped methods.
- `src/prompt/versioning/versioning-adapter.ts`: `VersioningAdapter` and `VersionInfo`.
- `src/prompt/versioning/git-versioning.ts`.
- `src/prompt/variations/variation-store.ts`: the interface.
  `turso-variation-store.ts`, `db/schema.ts`, and `db/migrations/`.
- `src/prompt/variations/canonical-updates.ts`: `canonicalizeUpdates`, `mergeUpdates` and
  `fieldValuesOf`.
- `src/prompt/variations/rebase.ts`: the field-wise three-way merge (pure).
- `src/file-provider-overlay.ts`: `OverlayFileProvider`.
- `src/cli/variation-loader-hook.ts`: the `?evalution-src=` load hook, registered in
  `src/cli/index.ts` next to the other hooks.
- `src/prompt/file/file-prompt-provider.ts`: ref handling, WIP editing, save, rebase on watch,
  materialization, and the `execute` result.
- `src/trace/trace-types.ts` and `src/trace/otel-attributes.ts`: `PromptID.version` and
  `PromptID.variation`.
- `src/server/api-routes.ts`: ref query parameters and the new routes.
- `src/client/`: the ref chip and menu, dirty indicator, Save/Discard, conflict bar, old-version
  banner, and trace columns. `optimistic-updates.ts` is unchanged: it still applies updates to
  whatever the editor shows.

## N. Verification

Unit tests (vitest; `MemoryFileProvider` except where noted):

- **`GitVersioning`** against a real temp repo, since this is real-git behaviour:
  - `head()` reports `HEAD`, clean or not. An untracked file makes the tree dirty and an ignored
    one doesn't.
  - `head()` leaves the user's index untouched.
  - An unborn `HEAD` has no commit.
  - `history()` lists commits that touched the file and skips ones that didn't.
- **`canonicalizeUpdates`:**
  - Edit-then-undo is empty.
  - Key order doesn't matter.
  - `modelParameters` merges per key.
  - `null` survives.
- **Rebase:** every row of §F's table, plus the `prompt` pseudo-conflict via `global_id` after a
  rename.
- **WIP lifecycle through `FilePromptProvider`** (with an in-memory commit adapter):
  - An edit leaves the file untouched and creates a WIP.
  - A run interns a frozen row, and a second run reuses it. On a clean tree, the run records the
    commit and the row's base is that commit. On a dirty tree, it records neither.
  - Edits over uncommitted changes to the same field run and save without conflicting.
  - Save writes the file and clears the WIP.
  - An external write to another field carries the WIP along. One to the same field marks it
    conflicted.
  - Without versions, variations still apply to the working tree.
  - `openOnHead` with no WIP creates one. With a WIP, it merges disjoint fields and reports a
    field both set differently as a conflict.
- **Materialization:** a variation's parsed prompt reflects its updates, and `readFile` on the real
  path still returns the original.

Real-FS tests (the load hook can't be exercised through `MemoryFileProvider`'s `data:` URLs):

- A variation of a prompt that imports a sibling module runs with the patched `system` and the
  sibling's real export.
- Two variations of one file imported in the same process don't share a module instance.

Manual, against asgard:

- Edit Odin's system prompt in the playground and confirm `odin.prompt.ts` is unchanged on disk.
- Run, and confirm the trace shows a variation, and a version only when the tree is clean.
- Edit the file in the IDE and confirm the WIP rebases.
- Save, and confirm the file has both edits.
