# Proposal: Dataset views — tabs beside the grid

> **Status: IMPLEMENTED (2026-10-13)** for evalution's part: §G steps 1–3. Step 4 is asgard's.
> One gap remains in §D: leaving a row with a draft asks only whether to discard it, using the
> browser's `confirm`, and closing the dataset doesn't ask at all. A failed Save restores the
> draft.
>
> **Proposed 2026-10-12.** The second surface for the sandboxed views in
> `specs/trace-visualizers.md` §A.1, which this spec relies on for everything about frames:
> bundling, the frame document and its CSP, the protocol envelope, `openUrl`, and the write-back
> rules. It also uses `specs/datasets.md` §Q for row labels and paths. Comparing rows is left to a
> comparisons spec still to be written (§F).

## Context

asgard's planTask datasets seed a task hierarchy into each row. The golden row declares six
`seededTask` instances. One is `evalutionProject`, and the other five are its children, each
`parentTaskId` an instance reference such as `@evalutionProject.taskId`. One of the children,
`seededTask` ("Web site for Evalution"), is the task the prompt is asked to plan; the prompt's
inputs point at it. Today:

- **The grid** shows a chip per seeded resource, so every row looks alike. `datasets.md` §Q's row
  label and added columns fix *which task is this row about*, but not *what does its world look
  like*.
- **The details pane** shows each instance in its own small resource editor. A six-task tree
  becomes six disconnected forms. You can't see the hierarchy, and reshaping it (add a child, move
  a task) means editing `parentTaskId` references by hand. The pane is cramped already.

Tabs fix both. The dataset view gets a tab row like the trace view's. **Grid** is the default and
is the view that exists today. A project can add tabs, such as **Task Hierarchy**, each shown only
when its `applies` says so, and each able to visualize and edit.

---

## A. A dataset view is a view on the `datasets` surface

```tsx
// .evalution/views/datasets/task-hierarchy.tsx
import { datasetView } from "evalution/views";
import { react, type DatasetViewProps } from "evalution/views/react";
import { seededTree } from "../../shared/task-tree.ts";

export default datasetView({
  label: "Task Hierarchy",
  applies: ({ overview }) =>
    Object.values(overview.instances).some(i => i.uri.endsWith("#seededTask")),
  mount: react(TaskHierarchy),
});

function TaskHierarchy({ selected, proposeUpdate }: DatasetViewProps) {
  if (!selected) return null; // the host selects a row before showing a view tab (§C)
  const tree = seededTree(selected.row.resources ?? {});
  // …render and edit the tree; each edit calls proposeUpdate(…) (§D)
}
```

Everything generic about views is unchanged from `trace-visualizers.md`:

- one file per view, the default export, discovered under `.evalution/views/datasets/`;
- its own sandboxed frame with no network, talking to the host only by `postMessage`;
- `mount`/`update`, React through the optional adapter, theme properties, and `openUrl` with
  confirmation;
- hidden frames to answer `applies`;
- the write-back rules: views propose, the host disposes.

The same file layout means a view's tree builder can be shared with the trace's Tasks tab.
`seededTree` in `.evalution/shared/task-tree.ts` (`trace-visualizers.md` §F) takes a
`RunResources`. A trace's root span records one with receipts, and a dataset row holds one
without. The builder keys nodes by instance name and carries the receipt's task id when there is
one, so the same function serves both.

## B. The surface descriptor

| | datasets | notes |
| --- | --- | --- |
| directory | `.evalution/views/datasets/` | |
| helper | `datasetView()` | |
| subject | `{ dataset: Dataset, overview: DatasetRowsOverview }` | What `applies` sees. Never rows: rows are paged and grow without bound, and a tab that appeared or vanished as you scrolled would be wrong. `overview.instances` (`datasets.md` §Q.2) is what lets `applies` ask "do any rows seed tasks?" without fetching them. |
| changes | a fresh snapshot on each `dataset-changed` | Both halves are small. |
| final when | until the next change | Frames that answer `false` are dropped and re-mounted on the next `dataset-changed`. That is the same rule `trace-visualizers.md` §C.2 applies to a late span: a dataset is simply never "live". |
| context | `selected: { index, row, label } \| null` | The shared selection (§C). `label` is the row's `rowLabel` value (`datasets.md` §Q.3). The row arrives in full, `rev`-stamped, and is resent when it changes. |
| actions | `selectRow(index)` (ephemeral), `proposeUpdate(update, rev)` (effectful) | §C, §D. |
| placement | a tab beside **Grid**, above the main area; the details pane is shared | §C. |

`DatasetViewProps` is `ViewProps` plus `dataset`, `overview`, `selected`, `selectRow`, and
`proposeUpdate`.

**Many rows at once is reserved, not built.** A view that wants to draw the whole dataset, such as a
board of every row's tree, would need a paged `requestRows(range)` action and a `rows` message.
The envelope has room for it, and nothing here needs it yet.

## C. Selection, the row list, and the details pane

**Selection belongs to the dataset view, not to the grid.** Today, the details pane shows the
grid's selected row, and closing the pane clears the grid selection (`DatasetView.tsx`:
`onClose={() => setSelection(NO_SELECTION)}`). With tabs, that splits into two pieces of state:

- **`selected: { index, rowId } | null`** is shared by every tab. It is the grid's selected row
  while Grid is showing, the row a view tab displays, and the row the details pane edits.
  Switching tabs keeps it. Switching back to Grid selects and scrolls to it.
- **Whether the details pane is open** is separate. In **Grid**, closing the pane still clears the
  selection, as today; in the grid, a selection without a pane has nothing to show. In a **view
  tab**, closing the pane only hides it. The tab keeps showing its row, and a "Details" button in
  the tab bar reopens the pane. This is the same arrangement the trace view has, where the
  Tasks tab shows the whole trace whatever the details pane is doing.

**The host draws the row list.** A view tab takes the grid's place, so something has to let you
move between rows. Rather than every view drawing its own list, the host shows a narrow one beside
every view tab:

- Each entry is the row's number and its `rowLabel` value (`datasets.md` §Q.3), so the list reads
  "1 · Web site for Evalution", not "Row 1". It pages through the same `RowPager` the grid uses.
- ↑/↓ move the selection, and the view gets the new row as a `context` update.
- Entering a view tab with nothing selected selects the first row. A view therefore always has a
  row to show unless the dataset is empty, in which case the host shows "No rows" and doesn't
  mount the component.

A view that will never want the list (the reserved many-row case in §B) could opt out later with
`rowList: false`. No current view needs that.

## D. Editing: proposals, the draft, and Save

The task hierarchy editor proposes `DatasetRowUpdate`s: add a child, reparent, rename, change
status or assignee, delete a subtree. The generic rules from `trace-visualizers.md` §A.1 apply,
and this is the first surface that uses them, so here is what they mean in practice:

- **The host keeps a draft per row.** A proposal for the selected row is checked: its `rowId` is
  the selected row's, its `rev` is current, and it came from the visible frame. It then folds into
  the draft with `applyUpdate` (`dataset-grid.ts`, which already merges updates for optimistic
  edits). The view gets the draft-applied row back as `context`, so it draws what it proposed
  without keeping its own copy.
- **A Save/Discard bar** appears under the tab while a draft is pending. Save sends the draft as one
  `updateRows`, which the server validates as it validates the details pane's edits. Discard drops
  the draft and resends the stored row. A tree editor suits this: rearrange several tasks, then
  save once. The local auto-commit question (`trace-visualizers.md` §J.7) can wait until the bar
  turns out to be friction.
- **The details pane edits the stored row, not the draft.** It shows a banner while the tab has
  unsaved changes for the same row. If the pane commits first, the row's `rev` moves, and the draft
  becomes stale. Save is then refused with "this row changed since you started; discard and
  redo". The draft isn't rebased automatically, because a structural edit (a reparent, a delete)
  has no general merge with an unrelated one.
- **Leaving a row with a draft** (another row, another tab, closing the dataset) asks to save or
  discard, the same question an unsaved editor asks.

**Reference bookkeeping is evalution's job, not each view's.** Every task hierarchy editor would
otherwise rewrite the same instance-graph logic. So `evalution/views/datasets`, which is
browser-safe and framework-free, exports pure helpers that compute updates:

```ts
/** Adds an instance under a fresh valid name (`isValidInstanceName`), based on `hint`. */
addInstance(row: DatasetRow, instance: ResourceInstanceInput, hint?: string): { name: string; update: DatasetRowUpdate };
/** Replaces some of an instance's arguments. */
setArgs(row: DatasetRow, name: string, args: Record<string, ExecutionInput | null>): DatasetRowUpdate;
/** Removes instances, or reports what still refers to them (cells, other instances) and changes nothing. */
removeInstances(row: DatasetRow, names: string[]): DatasetRowUpdate | { dangling: Reference[] };
/** Every instance reference in the row: from where, to which instance and output. */
references(row: DatasetRow): Reference[];
/** `datasets.md` §Q.1's path reading, re-exported. */
readColumnPath(row: DatasetRow, path: ColumnPath): ExecutionInput | "absent" | "n/a";
```

The host checks proposals with the same helpers before staging them. A proposal that would leave a
dangling reference is refused with the references listed, rather than saved and left to fail on the
next run.

## E. asgard: the Task Hierarchy tab

The worked example. All of it lives in asgard.

- **`applies`**: any row seeds a `seededTask` (§A).
- **The tree** comes from `seededTree(selected.row.resources)`. The roots are the instances with
  no `parentTaskId`. The focus task, which the prompt's inputs point at (found with
  `readColumnPath` from `toolsContext` › `create_task` › `rootTaskId`), is highlighted.
- **Editing**:
  - Title, status, and assignee are edited inline. The status options come from `seededTask`'s
    argument schema, which the view knows as the project's own code.
  - The description is edited in a side panel within the view, since descriptions run long.
  - **Add child** uses `addInstance` with a `parentTaskId` reference to the parent, and a name
    hinted from the title (`brandKit`, as the golden row's author named theirs).
  - **Drag to reparent** uses `setArgs` on `parentTaskId`.
  - **Delete subtree** uses `removeInstances` on the node and its descendants. It is refused,
    listing the references, if the prompt's inputs point into the subtree, which they do when it
    contains the focus task.
- **Not in v1: moving the focus.** Making another task the one being planned means rewriting the
  prompt's own inputs (`toolsContext`'s `rootTaskId`, `seededThreadMessages`' `taskId`), not just
  resources. That is a bigger edit to let a sandboxed view propose. See §I.2.

## F. Comparing rows: not here

The comparisons that matter most right now are between runs, not rows: two runs of the same row,
two eval runs (the current eval comparison isn't useful), and two prompt versions or variations.
They belong in a comparisons spec that covers every surface. That spec should decide how a view
takes part in a comparison, so this spec reserves nothing for it beyond what §B already allows
(`selected` can grow into a pair).

## G. Phasing

Depends on `trace-visualizers.md` steps 1–3 (the generic view machinery) and on `datasets.md`
§Q steps 1–3 (paths, `overview.instances`, and the row label).

1. **The surface.** The `datasets` descriptor, `datasetView()`, and `DatasetViewProps`. A unit test
   runs the generic layer against it as its second real surface.
2. **Tabs and selection.** The tab row with **Grid** first, view tabs on `applies`, the dataset
   view's own `selected`, the details pane decoupled from the selection in view tabs, and the
   host's row list with keyboard navigation. Playwright CT for selection surviving a tab switch,
   closing the pane in a view tab keeping the row, and ↑/↓ in the row list.
3. **Write-back.** Draft per row, `applyUpdate` folding, the Save/Discard bar, `rev` staleness, the
   leave-with-draft prompt, and the `evalution/views/datasets` helpers, with unit tests for
   `addInstance` naming, `removeInstances` dangling detection, and `references`. This is the first
   effectful action on any surface, so it also tests that a hidden frame's proposal is ignored.
4. **asgard: Task Hierarchy** (§E), sharing `seededTree` with the trace Tasks tab.

## H. Files

- `src/views/surfaces/datasets.ts`: the descriptor, `datasetView()`, and `DatasetViewProps`.
- `src/views/datasets/index.ts`: the `evalution/views/datasets` entry with the helpers in §D
  (`package.json` `exports`). It re-exports `readColumnPath` from `src/shared/column-paths.ts`.
- `src/client/components/DatasetView.tsx`: the tab row; `selected` lifted out of the grid
  selection; and the pane's open state.
- `src/client/components/dataset/DatasetRowList.tsx`: the host's row list.
- `src/client/components/dataset/RowDraftBar.tsx`: Save/Discard, staleness, and leave prompts.
- `src/client/components/dataset/row-draft.ts`: the draft per row, as pure state: fold, stale,
  save, and discard.

## I. Open questions

1. *Should Grid be a tab of its own, or the space the tabs sit above?* As a tab, it can be left
   for a view, and a dataset could even open on a view tab when one applies. Make it a tab, and
   remember the last tab per dataset per viewer, as the trace view will.
2. *Moving the focus.* An effectful action that rewrites the prompt's inputs, not just resources.
   It is the same `DatasetRowUpdate` (`cells` as well as `resources`), and the same staging and
   Save apply, so the mechanism is already there. What isn't clear is whether a view should be
   allowed to change *what the row is asking*, or only *the world it sets up*. A possible
   middle ground is to allow cell edits only through a path the dataset has named, such as
   `rowLabel`'s field. Decide when the editor exists and the need is concrete.
3. *Rows that don't seed a tree.* `applies` is per dataset, so a dataset with a few rows lacking
   `seededTask` still gets the tab. The view shows "No tasks seeded in this row" for those. That
   is probably right, because the tab's presence shouldn't flicker as you move between rows.
