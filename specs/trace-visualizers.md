# Proposal: Trace visualizers, and getting "before" into the trace

> **Status: IMPLEMENTED (2026-10-13)** for evalution's part: §H steps 1–4, plus step 7's first
> building blocks (`<SpanLink>`, `<TextDiff>`, `<JsonView>`). Steps 5–6 are asgard's, and 8–11 are
> later work. Step 12 shipped as `specs/dataset-views.md`. Where the code differs from the text
> below, the text has been updated, except for one addition: the host side of the protocol is a
> pure function in `src/views/host.ts`, next to the frame side in `runtime.ts`.
>
> **Proposed 2026-10-12.** Revives part of `specs/resource-observation.md`: not its
> machinery, but its question, *where does the state before a change come from?* Visualizers are
> the first feature that has to answer it the way online evals eventually will. Revised the same
> day: visualizers are discovered only under `.evalution/views/traces/`, and each runs in its own
> sandboxed iframe, because they will run in the cloud. The frame machinery is generic over
> *surfaces* (§A.1). Traces are the first surface, and datasets are reserved as the second, for a
> custom visualizer or editor whose design is still open.

## Context

The trace view has two fixed tabs, **Conversation** and **Spans**. Both are generic: they show
what any agent did in terms any agent shares, such as messages, tool calls, and timings. What an
app's own tools *mean* never appears. In asgard, a planning run that calls `create_task` four times
and `update_task` twice changes a task hierarchy, but the trace shows six JSON blobs. The question
a reviewer actually asks, *what does the tree look like now, and what moved*, can only be answered
by reading them all and doing the fold in your head.

The ask:

1. **Custom visualizers, added the way checks and resources are.** Each is a module export with a
   pure `applies(trace)` over the same `TraceWithSpans` a check gets. When it applies, the trace
   view gets a tab beside Conversation and Spans, and the visualizer supplies what goes in it.
2. **First user: asgard's task hierarchy.** Show the part of the tree a run touched. For an
   `update_task`, show the diff, which needs the task's value *before* the update.
3. **Plan for runtime evals without building them.**

(2) is where this stops being a UI feature. `update_task`'s input is a delta and its output is
`{ taskId }`, so the trace records what was written but not what it replaced. That gap is what
`resource-observation.md` set out to fill, and why it is back on the table.

---

## A. A visualizer is a browser module, and each one gets its own sandboxed frame

One file, one visualizer, the default export:

```tsx
// .evalution/views/traces/task-tree.tsx
import { traceView } from "evalution/views";
import { react, SpanLink, type TraceViewProps } from "evalution/views/react";
import { taskChanges } from "../../shared/task-changes.ts";

export default traceView({
  label: "Tasks",
  applies: trace => taskChanges(trace).length > 0,
  mount: react(TaskTree),
});

function TaskTree({ trace, selectedSpanId, selectSpan, openUrl }: TraceViewProps) {
  const changes = taskChanges(trace);
  // …render the tree; each changed node is a <SpanLink spanId={…}> to the span that changed it
}
```

The core contract has no framework in it. A visualizer **mounts** into an element and is told when
its props change:

```ts
// Generic: every surface's views have these.

/** What every view is given, whatever its surface. */
export interface ViewProps {
  /** Asks the host to open an http(s) URL in a new tab, which it does after the viewer confirms (§C.1). */
  openUrl(url: string): void;
}

/** A mounted view. */
export interface MountedView<P extends ViewProps> {
  update(props: P): void;
  unmount?(): void;
}

/** A view on a surface whose subject is `S`. */
export interface ViewDefinition<S, P extends ViewProps> {
  /** The label the host shows for it (a tab, for traces). Defaults to the file name. */
  label?: string;
  /** Whether this subject gets the view. Pure and synchronous: called on every change. */
  applies(subject: S): boolean;
  /** Renders into `element`, which fills the space the host gives it. */
  mount(element: HTMLElement, props: P): MountedView<P>;
}

// The trace surface (§A.1).

/** What a trace view is given, on mount and on every update. */
export interface TraceViewProps extends ViewProps {
  /** The trace so far. Updated as spans arrive while the run is live. */
  trace: TraceWithSpans;
  /** The span selected in the host's details pane, if any. */
  selectedSpanId: string | null;
  /** Asks the host to select a span, which opens it in the details pane. */
  selectSpan(spanId: string): void;
}

export type TraceViewDefinition = ViewDefinition<TraceWithSpans, TraceViewProps>;
```

**React is an optional peer dependency, not a runtime one.** Evalution's own client ships
prebuilt, so evalution never needs React at run time. The only React in play is the one inside a
visualizer's bundle, and that one can come from the author's project:

- **`evalution/views`** is the core: `traceView()`, the types, and the frame runtime. It has
  no framework imports, so a visualizer written with plain DOM, Preact, Svelte, or lit needs nothing
  else.
- **`evalution/views/react`** is the adapter: `react(Component)`, which returns a `mount`
  backed by `createRoot` with an error boundary, plus the building blocks (§B.4) as React
  components. It imports `react` and `react-dom`, which `package.json` lists in
  `peerDependencies` with `peerDependenciesMeta: { optional: true }`. tsdown keeps them external,
  so they are resolved from the author's project when their visualizer is bundled. A project that
  imports the adapter without React installed gets a module error that says to install `react`
  and `react-dom` (§B.2), not esbuild's raw "could not resolve".
- **Theme tokens are framework-neutral.** The runtime sets them as CSS custom properties on the
  frame's `:root`, so a non-React visualizer gets light and dark mode the same way the building
  blocks do.

If non-React authors ask for the building blocks, the route is custom elements
(`<evalution-span-link>`), which React 19 consumes natively, not a second copy for each framework.

**Visualizers run in the browser, not the server.** Checks and resources are *playground modules*.
They load into the server's Node process because they need to: a resource opens a database, and a
check queries it. A visualizer needs neither. It needs a DOM and the trace. So visualizers are a
second kind of module, **browser modules**, which the server finds and bundles but never imports
(§B).

**Each visualizer runs in its own sandboxed iframe and talks to the trace view only by
`postMessage`** (§C). This is for the cloud. There, a visualizer is code one person wrote, running
in the browser of someone else viewing a production trace while signed in to evalution. The frame
keeps that code away from the host page and the viewer's session, and it keeps the trace off the
network (with limits stated in §B.3). Locally, where the author and the viewer are the same
person, the frame costs little and means the same bundle behaves identically in both places. The
runtime that `evalution/views` contributes to every bundle handles the protocol, so an author
writes `applies` and `mount` and never touches a message.

What follows from the frame:

- **The UI is whatever the author writes.** That includes their framework and their CSS. The
  alternative was a declarative view vocabulary, where `view(trace)` returns
  `{ kind: "tree", nodes }` and evalution renders it. That vocabulary would always be one primitive
  short of what the author needs, and the task tree, with field diffs and reparents drawn as
  moves, is already a custom shape. The frame makes arbitrary UI safe to allow, which was the main
  argument for the vocabulary.
- **`applies` runs in the frame too.** The frame is both the predicate and the renderer. The trace
  view streams spans into every visualizer's frame, including frames that aren't showing (§C). The
  Tasks tab appears as soon as the first `create_task` span arrives, and evalution never has to
  evaluate user code anywhere but a sandbox. That matters most in the cloud, where the server must
  not run it at all.
- **A visualizer can't harm the trace view or the other visualizers.** A throwing component, a
  `while (true)`, or a stray global stays in its own frame. Each frame is its own bundle (§B.2),
  so a build error in one file also leaves the others alone.

### A.1 The frame machinery is generic; a surface supplies the rest

A **surface** is a place in the app where sandboxed views can appear. Traces are the first.
Datasets will be the second, as a custom visualizer or editor, but what that is hasn't been decided.
Almost everything in §B and §C is about frames, not about traces, so the code is split along that
line from the start. That way the dataset surface is an addition, not a refactor.

**Generic** (`src/views/`, and the host's `ViewFrame`):

- Discovery, one file per view, the per-file build, module errors, and rebuilds (§B.1–§B.2).
- The frame document, its CSP, and the host page's `frame-src`. One route serves every surface's
  frames (§B.3).
- The runtime's lifecycle: the handshake and `protocol` version, `mount`/`update`/`unmount`, error
  capture, and theme properties.
- `openUrl` and its confirmation. These are the actions every view has.
- The host side: `event.source` checks, navigation detection, hidden mounting for `applies`, error
  display, and the write-back rules below.
- `react()`, and the building blocks that don't belong to one surface (`<JsonView>`, `<TextDiff>`).

**Per surface** (a `Surface` descriptor in `src/views/surfaces/<name>.ts`, imported by both sides):

| | trace | what it is for |
| --- | --- | --- |
| directory | `.evalution/views/traces/` | The server never runs a view, so it can't ask one which surface it's for. The directory is the declaration. |
| helper | `traceView()` | Tags the definition with its surface; a trace view in the wrong directory is a module error. |
| subject | `TraceWithSpans` | What `applies` and the view see. |
| changes | `TraceLiveEvent`, reduced by `applyStreamEvent` | An initial snapshot plus incremental events. A surface with a small subject can resend snapshots instead. |
| final when | `trace-end` | When an `applies` answer can't change, so frames that don't apply can be dropped (§C.2). |
| actions | `selectSpan` (ephemeral) | What a view may ask the host to do, and the host-side handler that validates each one. |
| context | `selectedSpanId` | Host state the view is told about but doesn't own. |
| placement | tabs beside Conversation and Spans | Where the host mounts the frames. |

So the protocol (§C.1) is a generic envelope, with `init`, `subject`/`event`, `context`, and
`action` from the host, and `ready`, `applies`, `action`, and `error` from the frame. The surface
narrows the payloads. The trace-specific rows of §C.1's table are the trace surface's instance of it.

**Writing back: views propose, the host disposes.** A dataset editor would be the first view to
change something outside its frame. It has no network, so any write is really the host acting on
the frame's behalf, with the viewer's credentials. That makes it the same problem as `openUrl`,
and it gets the same answer. These rules are generic, and they are set now so the dataset surface
doesn't have to invent them:

1. **Every lasting effect passes through host chrome that the viewer clicks.** A surface classifies
   each action. An *ephemeral* action (select, highlight) is applied directly. An *effectful*
   action is staged by the host and applied when the viewer confirms in host-rendered UI, such as
   a Save/Discard bar under the view. An editor's edits land in the host's draft; the frame can't
   commit them. Letting a local editor auto-commit could be added later as a convenience; it is not
   the default.
2. **A view can only propose changes to the subject it was given.** A row editor can propose an
   update to its own row and nothing else. The host validates each proposal the way it validates
   hand edits.
3. **Proposals carry the revision they were made against.** Every `init`, `subject`, or `event`
   message carries a host-assigned `rev`. A proposal names its `rev`, and a stale one is rejected
   (`{ type: "rejected", reason }`) and the current subject is resent. A view never silently
   overwrites a change made in the built-in editor or another tab.
4. **Hidden frames can't act.** A frame mounted only to answer `applies` is hidden, and the host
   ignores every `action` from a frame that isn't the one showing. A view can't do anything a
   viewer isn't looking at.

**What a dataset surface might be.** None of this is designed, but the candidates show the
descriptor is the right cut. Each is its own surface, not one surface with modes:

- **`dataset-row`.** The subject is `{ dataset: Dataset, row: DatasetRow }`. It appears in
  `DatasetRowDetails` beside the built-in form, and an editor proposes a `DatasetRowUpdate`. The
  subject is small, so snapshots are enough. This is the natural first one.
- **`dataset-field`.** A renderer or editor for one field's values, chosen by
  `applies({ field })`, for example a JSON field that holds a task tree. Probably details-pane only,
  because a frame per visible grid cell doesn't scale.
- **`dataset`.** A whole-dataset view. Rows grow without bound, so the subject has to be paged: the
  view asks for a range and the host sends it. That is the one candidate the snapshot-and-events
  model doesn't cover, and it can be added to the envelope when it's needed.

All three have to decide one thing that traces don't: cells are `ExecutionInput`s (a literal, a
resource reference with arguments, and so on), not plain values. An editor should probably see and
propose `ExecutionInput`s, with helpers for the literal case, because an edit has to round-trip
through the same row-editing path as a hand edit (`dataset-row-editing.ts`).

## B. Discovery, bundling, and the frame document

### B.1 Discovery: one file, one visualizer

Browser modules live in one place only: `.evalution/views/<surface>/`, one directory per
surface (§A.1).

```ts
export const DEFAULT_VIEW_INCLUDE_PATTERNS = SURFACE_NAMES.map(
  name => `${VIEWS_DIR}/${name}/**/*.{ts,tsx}`,
);
```

Each surface adds its own directory (`SURFACE_NAMES` in `src/shared/view-surfaces.ts`). Files under `.evalution/views/` but outside a known surface's
directory are reported (“no surface named `foo`”), not ignored, so a typo doesn't make a view
silently vanish.

There is no `*.visualizer.tsx` pattern alongside prompts. Unlike `*.playground.ts`, a `.tsx` next
to app code is exactly what an app's own bundler or `tsc` picks up, and a visualizer imports
`evalution/views`, which the app's production build shouldn't contain. Keeping them under
`.evalution/` keeps them out of the app's build by construction. If a co-located pattern is wanted
later, it can be added beside this one without changing a URI.

**Every matching file is one visualizer, and its default export is the definition.** This is a
deliberate departure from checks and resources, where any number of named exports can live in one
module, and it removes a whole step:

- **The server learns what exists from a directory listing.** The server never executes a browser
  module, so with named exports it would have had to mount a frame per export to find out which
  ones were visualizers. Now the file *is* the visualizer, and nothing is mounted only to be thrown
  away.
- **The URI is the module path relative to `rootDir`**, with no `#export`, because there is only
  one.
- **Bundling has a fixed entry**: `import v from "<module>"; start(v)`. There is no generated
  re-export list and no metafile export scan.
- **Named exports are allowed and ignored.** Helpers can live beside the visualizer.
  `.evalution/shared/` is only for derivations that a check imports too (§F, §G).

A default export that isn't a `traceView()`, or a missing default export, is a module error
reported by the frame's `ready` message (§C.1). `traceView()` still tags its result
(`VIEW_TAG = Symbol.for("evalution.view")`) so the runtime can tell. Visualizers are
**project-scoped, not provider-scoped**. Checks are provider-scoped only because their resource
inputs have to come from the right lease, and visualizers have no inputs. `applies` does all the
filtering.

### B.2 Bundling: one bundle per file

A `ViewRegistry` on the server builds **each file separately** with esbuild
(`platform: "browser"`, `format: "esm"`, minified). It is one bundle per file because a frame loads
exactly one visualizer, and a broken file must not take the others with it.

- **Resolution is the author's project's**, with one exception: `evalution/views` and
  `evalution/views/react` resolve to the copy of evalution that is running, so the runtime
  always speaks the host's `protocol`. `react` and `react-dom` come only from the author's project
  (§A). An unresolved `react` is rewritten into the "install React" error.
- **esbuild becomes a runtime dependency.** It is only a transitive dev dependency today. It can't
  be an optional peer the way React is: every visualizer needs it, whatever it's written in. It can
  be loaded lazily, with `import()` on first discovery, so a project with no
  `.evalution/views/traces/` never loads it.
- **A failed build is a `ViewModuleError`**, recorded against the file and shown in place of
  its tab. This plays the same role as `PlaygroundModuleError`. A `node:` import is the expected
  case: it means server-only code was imported by accident, and the message should say so.
- **Reads go through the `FileProvider`** (an `onLoad` plugin). That way the registry can be
  unit-tested against `MemoryFileProvider`, and an overlay sees unsaved edits.

The registry rebuilds a file when it or anything it imports changes, using the watcher the
playground modules use. It announces the rebuild on `/api/events` as
`{ type: "views-changed", version }`.

### B.3 The frame document

`GET /api/views/frame?uri=<uri>&v=<moduleVersion>` returns a complete HTML page: the file's
bundle inline in a `<script type="module">`. The page is served with:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 'nonce-<n>'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
  form-action 'none'
Cache-Control: private, max-age=31536000, immutable
```

and embedded as `<iframe sandbox="allow-scripts" src="…">`. Note that `allow-popups` is not in the
sandbox, because links go through the host (§C.1). **The host page carries a policy of its own**,
which is what pins the frame in place:

```
Content-Security-Policy: frame-src <host origin>/api/views/frame
```

The server sets this on the client's HTML, which `serveStatic` in `src/server/index.ts` serves
with no CSP today. The client embeds no other frames, so this restricts nothing else. In the cloud,
the source is the user-content origin's frame path instead.

- **`sandbox` without `allow-same-origin`** gives the frame an opaque origin. It can't read the
  host's cookies, storage, or DOM, and it can't reach the parent except by `postMessage`. The
  CSP repeats the sandbox, so the document is sandboxed even if it is opened directly rather than
  through the iframe. **This is the hard boundary**: the viewer's session and the evalution app are
  out of a visualizer's reach.
- **`default-src 'none'` blocks the ordinary network.** A visualizer can't `fetch`, open a socket,
  beacon, load a remote image or font, or nest a frame of its own. `form-action` is listed
  separately because it is the one fetch-like directive that doesn't fall back to `default-src`.
  The sandbox already blocks forms; the directive covers the frame document opened directly.
- **The host's `frame-src` blocks the frame from navigating itself.** Without it, a frame that sets
  `location = "https://anywhere/?data=…"` would carry the trace out in the URL. No sandbox flag
  prevents a frame navigating *itself*, and the frame's own CSP doesn't govern its navigations.
  The *embedder's* `frame-src` does: browsers check it on every navigation of a child frame,
  whoever started it, including redirects. So a navigation anywhere but the frame route is refused
  before a request is sent. (`child-src` would work too, as `frame-src`'s fallback, but it also
  governs workers; `frame-src` is the precise one.) Three details:
  - **The source carries the path**, not just `'self'`. Otherwise the frame could still navigate to
    any URL on the host's origin. Locally that doesn't leave the machine, but there's no reason to
    allow it. Path matching ignores the query, so a frame can only ever navigate to *another
    visualizer frame*, which is harmless.
  - **Enforcement is each browser's, so it's tested in each one.** The Playwright test for this
    (§H step 3) runs in Chromium, Firefox, and WebKit; the project runs only Chromium today. The
    test sets the host policy with a `<meta http-equiv>` tag, which `frame-src` honors.
  - **The host still counts the iframe's `load` events.** A blocked navigation typically leaves an
    error page in the frame, so a second `load` now means "a navigation was attempted". The frame
    is torn down, and its tab says "This visualizer tried to navigate away and was stopped". That
    makes an attempt visible rather than silently dead, and it is the backstop if a browser ever
    fails to enforce the policy.
- **What remains is narrow and deliberate.** WebRTC can reach a STUN or TURN server the author
  controls, and no shipped CSP directive or permissions policy blocks it (CSP's `webrtc` directive
  isn't implemented). DNS prefetch can leak a few bytes per lookup. Neither happens by accident,
  and both need infrastructure the author runs. Deleting `RTCPeerConnection` from the frame's
  globals doesn't help, because a nested `about:blank` frame hands it back. So the claim the docs
  can make is: **a visualizer can't reach the viewer's session, and it can't send the trace
  anywhere except by deliberately abusing WebRTC.** In the cloud, the control for that is **who
  can upload a visualizer** (project members, through the CLI), and every visualizer should show
  its author and when it was uploaded.
- **Inlining the bundle** is also what keeps the frame working with `request-guard.ts`.
  Subresource requests from an opaque origin carry `Origin: null`, which the guard rightly refuses,
  so the frame makes none. The one request is the navigation that loads the page.
- **No storage.** `localStorage` throws on an opaque origin. That is fine for a visualizer's state
  (it's tab-local UI) and needs a sentence in the docs.
- **In the cloud,** the same document should come from a separate origin (a user-content domain)
  as defense in depth, beyond the sandbox. Nothing in the protocol depends on where it's served
  from.

`GET /api/views` returns `{ version, views: { uri, surface, moduleVersion }[], errors:
ViewModuleError[] }`. Labels come from the frames' `ready` messages.

### B.4 Building blocks

`evalution/views/react` exports a few components drawn from what the client already has:
`<JsonView>` and `<TextDiff>` (wrapping `text-diff.ts`, which moves to `src/shared/` so both sides
can import it) are generic. `<SpanLink spanId>` (calls `selectSpan`) belongs to the trace surface,
which is why the React adapter's surface-specific components are exported per surface
(`evalution/views/react` re-exports them for now). They are styled with the theme custom
properties (§A), so a visualizer matches light and dark mode without knowing either. Grow the set
when a second visualizer wants the same thing, not before.

## C. The trace view and the protocol

### C.1 Messages

Versioned and small. This is the generic envelope from §A.1, filled in for the trace surface.
Rows marked *generic* are the same for every surface:

| direction | message | when | |
| --- | --- | --- | --- |
| frame → host | `{ type: "ready", protocol: 1, surface, label }` or `{ …, error }` | the runtime has loaded the default export, or found it isn't a view for this surface | generic |
| host → frame | `{ type: "init", subject: TraceWithSpans, rev, context: { selectedSpanId }, theme }` | in reply to `ready` | generic envelope |
| host → frame | `{ type: "event", event: TraceLiveEvent, rev }` | each span or trace update while live | trace |
| host → frame | `{ type: "context", context: { selectedSpanId } }` / `{ type: "theme", theme }` | the host's selection or theme changed | generic envelope |
| frame → host | `{ type: "applies", value: boolean }` | after `init`, and whenever the answer changes | generic |
| frame → host | `{ type: "action", name: "selectSpan", args: { spanId } }` | the visualizer called `selectSpan` | trace |
| frame → host | `{ type: "openUrl", url }` | the visualizer called `openUrl` | generic |
| frame → host | `{ type: "error", message }` | `applies`, `mount`, or `update` threw | generic |

The trace surface has no effectful actions, so it never uses `rev` or `rejected` (§A.1). They are
in the envelope from the start so the dataset surface doesn't have to bump `protocol`.

- **Live traces stream as events, not snapshots.** The frame runtime keeps its own
  `TraceWithSpans` by applying `TraceLiveEvent`s, which is the same reducer `TraceView` uses
  (`applyStreamEvent`, moved to `src/shared/` so both import it). A long run doesn't re-send the
  whole trace on every span.
- **The host checks `event.source === frame.contentWindow`** on every incoming message, because
  an opaque origin's `event.origin` is `"null"` and identifies nothing. The runtime checks
  `event.source === parent`. The host posts with target origin `"*"`, which is the only option
  for an opaque origin. That is acceptable because the recipient is a specific window the host
  created, running code that already has the trace.
- **Everything from the frame is untrusted.** An `action` goes to the surface's handler, which
  validates it: `selectSpan` is honored only for a span id in the current trace. Actions from a
  hidden frame are ignored (§A.1). `error` text is rendered as text.
- **`openUrl` always asks first.** The host accepts only `http:` and `https:`. It shows a dialog
  naming the visualizer, with the URL's host prominent and the **full** URL below it (wrapped,
  never truncated). The URL is the payload, and a query string is where smuggled data would sit.
  The link opens only on confirm, with `noopener,noreferrer`. Because the sandbox has no
  `allow-popups`, this is the only way a visualizer can open a tab, so the confirmation can't be
  skipped, and the host's `frame-src` (§B.3) means a visualizer can't get around it by navigating
  its own frame there.
- **`protocol` is there so the cloud can serve older bundles.** A host that sees a `ready` with a
  protocol it doesn't speak shows "rebuild this visualizer" rather than guessing.

### C.2 Tabs

`MainTab` widens from `"conversation" | "spans"` to include `` `view:${uri}` ``. When a trace view
opens, it mounts **one hidden frame per visualizer** and sends each one `init`. Hidden means
`visibility: hidden` and full size, not `display: none`, so layout is correct the moment the frame
is shown. A frame's tab appears when it answers `applies: true` and disappears if the answer
changes to false.

- **Frames that don't apply are dropped once the trace is finished.** After `trace-end`, the trace
  stops changing, so every frame's last `applies` answer is final, and frames that answered
  `false` are removed. The steady-state cost is one frame per visualizer *that applies*. While a
  run is live, every frame stays, because any of them might start applying.
- **A late span brings them back.** On the OTel path, children can still be in an exporter's batch
  when the root ends (`evals.md` §D.3). A span event for a trace whose frames were dropped
  re-mounts them with a fresh `init`. This is rare, and it is cheaper than holding every frame on
  the chance it happens.
- **Opening a finished trace still mounts every frame once**, just long enough to answer
  `applies`. If that startup cost shows up, cache the answers in the host per
  `(traceId, uri, moduleVersion)`, since a finished trace's answer can't change, and skip mounting
  for cached `false`s. Measure before building it.
- **A frame that never sends `ready`** within a few seconds, or that sends `error` from `applies`,
  gets no tab. The failure is listed with the module errors from `/api/views`, so a broken
  visualizer is visible rather than silently absent.
- **An error from `mount` or `update` shows in the tab body.** The React adapter renders it inside
  the frame with an error boundary. For a non-React visualizer, the runtime catches it around
  `mount`/`update` and from the frame's `error` event. Either way it sends `error`, and
  Conversation and Spans are never affected.
- **The details pane is the host's.** `selectSpan` is the same `setSelectedSpanId` the timeline
  uses, so clicking a task opens its `update_task` span in the details pane. When the host's
  selection changes, it sends `context`, so the visualizer can highlight the node for it.
- **On `views-changed`,** frames whose `moduleVersion` changed are reloaded. The others
  keep their state.
- **The active tab can be remembered per URI** across trace views, as a per-viewer convenience in
  the host's `localStorage`. If the remembered visualizer doesn't apply to the trace now open, the
  view falls back to Conversation.

## D. The constraint that matters: a visualizer sees only the trace

A visualizer has no `inputs`. That isn't an omission. It runs whenever someone opens a trace, long
after the run's lease is gone, and it runs on traces that never had a lease at all: OTLP traces
from production, or a trace a teammate shared. Whatever it shows has to be **in the trace**.

That is exactly the constraint `evals.md` §K says online evals will have: *production has no
resources, so capture belongs in app code shipped with the app*. Offline checks escaped it by
running inside the lease and querying the live database. Visualizers can't, and so they hit the
constraint early, in a small and low-stakes form. That makes them the right place to settle how
state gets into a trace, before an eval API is shaped around the answer.

The principle to carry forward:

> **Anything that must work on a trace from anywhere is a function of `TraceWithSpans` alone.**
> Visualizers are, by construction. A check is, exactly when it declares no resource inputs (§G).

## E. Getting "before" into the trace: three producers

There are three places the value before an update can come from. They are listed cheapest first,
and a visualizer should use whichever is present.

| | where it works | costs | blind spot |
| --- | --- | --- | --- |
| 1. Fold what the trace already says, starting from the recorded seed | everywhere; complete only for playground and eval runs, which record their seed | nothing | production: anything the run never read. Playground: state seeded outside resource arguments |
| 2. The tool reports its own change | everywhere the app's tools run, production included | a small app change per tool | state no tool touched |
| 3. A resource observes the world | playground only | `resource-observation.md`'s machinery | production |

### E.1 Fold the trace, starting from the recorded seed (free)

**A playground or eval run records its seed.** The root span's `prompt` carries the run's
`resources`: every named instance with its arguments and the receipt its `create()` produced. It
also carries the unresolved `functionInputs` and `executeInputs`. In asgard's planTask datasets,
the seed *is* the task hierarchy. The golden row seeds six `seededTask` instances
(`evalutionProject` and five children), each `parentTaskId` an instance reference such as
`@evalutionProject.taskId`, and each receipt the real `tsk_…` id that `create()` minted. So the
trace already contains:

- **the whole initial tree, untouched siblings included**: one node per `seededTask` instance, with
  edges from the `parentTaskId` references;
- **the real id of every seeded task**, from its receipt. That's what lets a `create_task` or
  `update_task` call, which names tasks by id, attach to the right node;
- **the focus task**: the instance the prompt's inputs point at (`toolsContext.rootTaskId`,
  `seededThreadMessages.taskId`);
- **the tools' context.** `toolsContext` is an execute input, so it is recorded too. That includes
  the `rootTaskId` that `create_task` defaults its parent to, so even a create with no
  `parentTaskId` can be placed.

Fold the run's changes on top, in order: every `create_task` input with its output id, every
`update_task` delta, and every `get_task` and `list_tasks` output as evidence. The last value seen
for a field before an update is its "before". For a run that seeded its world through resource
arguments, that is complete.

There are two limits:

- **Production traces have no resources** (`evals.md` §K), so there is no seed. The fold falls
  back to whatever the model happened to read. A field it never read has no known previous value,
  so the diff can only show "→ *Set up CI* (was: unknown)", and a create with no `parentTaskId`
  can't be placed. This is the case E.2 exists for.
- **State seeded outside resource arguments isn't in the seed.** Examples are fixtures in
  `scripts/seed.sql`, which the `db` resource loads on `create` and `reset`, and rows that other
  code creates. A task that exists only there shows up only if the run reads it.

### E.2 The tool reports its own change (recommended now)

The tool already knows the answer: `updateTask` reads `getCurrentTaskState` before it writes. Let it
return what it changed, and keep that out of the model's context with the AI SDK's `toModelOutput`:

```ts
export const update_task = tool({
  // …
  execute: async ({ taskId, delta, dependsOnTaskIds }, { context: { db, workspaceId } }) => {
    const change = await updateTask(db, workspaceId, taskId, delta, { dependsOnTaskIds });
    return { ...ok({ taskId }), change };   // change: { before, after }, the touched fields only
  },
  // The model sees what it always saw; the trace records the whole return value.
  toModelOutput: ({ output: { change, ...result } }) => ({ type: "json", value: result }),
});
```

This approach is preferred because it has the online-eval property for free:

- **Same code in the playground and in production.** The trace records the tool's return value
  either way, on the `TOOL` span's `output`. Native telemetry records `toolOutput.output`, and the
  OTel path should record it as `ai.toolCall.result` (step 4 verifies both). A production trace
  ingested over OTLP gets the same Tasks tab with no evalution-side capture.
- **No evalution changes.** Nothing new is added to `Span`, the sink chain, or `ResourceInstance`.
- **It records facts, not a reconstruction.** That is `resource-observation.md` §D's argument for
  storing states over deltas, applied at the source. `change` is what the database held, read in
  the same call that wrote it.
- **It's small.** It holds the touched fields of one task, not a snapshot of anything. §D's size
  rules don't come into play.

`create_task` does the same with `{ before: null, after }`, which carries the resolved parent that
a production trace can't recover (E.1).

For playground and eval runs, E.1 already gives the same answers. E.2 is still worth doing there:
it is the *same* code that makes production traces work, and it states facts read from the
database rather than a reconstruction that is only as good as the fold.

The general form, for state that a tool's return value is the wrong home for, is an
**app-side span annotation**. App code records a named value on the active span through
`@opentelemetry/api` alone, using a documented attribute convention (`evalution.state.<name>`), so a
production app takes no dependency on evalution. It isn't needed for asgard, and it has a
prerequisite: evalution's native AI SDK integration doesn't make the `TOOL` span active during
`execute` today (it implements `onToolExecutionStart`, not the `executeTool` wrapper). Reserved;
see §J.1.

### E.3 A resource observes it (playground only; stays parked)

`resource-observation.md`'s `observe()`, called after `create` and at teardown, is the only producer
that captures state *neither the seed nor a tool describes*: fixtures loaded outside resource
arguments, rows other code wrote, and an "after" read independently of what the tools reported.
E.1's seed already covers the full hierarchy before a run, untouched siblings included, for
anything seeded through resource arguments. That removes the main reason this section once had.
It stays parked. If it ships, its samples should land in the trace in the same
shape E.2's convention reserves (`evalution.state.<name>` on the root span), so a visualizer reads
one shape whether the state came from the app or from a resource. That replaces its §C proposal of
a separate `evalution.resources` key.

## F. asgard: the Tasks tab

The worked example. All of it lives in asgard. Nothing here is evalution code.

- **`.evalution/shared/task-tree.ts`** builds the tree in two pure steps, so other views can reuse
  them:
  - `seededTree(resources)` turns a run's recorded `resources` into the initial tree. Nodes are the
    `seededTask` instances, keyed by instance name and carrying the receipt (the real task id)
    when there is one. Receipts are how tool calls find their node. Edges follow `parentTaskId`
    references. It also marks the focus task, which is the instance the prompt's inputs point at.
    A dataset row holds the same `RunResources` without receipts, so a dataset view can reuse the
    builder (`specs/dataset-views.md`).
  - `applyChanges(tree, taskChanges(trace))` overlays the run.

  It imports only types and helpers from `evalution/checks`.
- **`.evalution/shared/task-changes.ts`** exports `taskChanges(trace)`: one entry per successful
  `create_task` or `update_task` span, `{ spanId, taskId, kind, before, after }`. It takes these
  from the `change` field (E.2), and falls back to the fold (E.1) for traces recorded before the
  tools changed.
- **`.evalution/views/traces/task-tree.tsx`** renders the result:
  - **Playground and eval runs: the whole seeded hierarchy.** Untouched siblings are dimmed, so the
    reviewer sees where a new task landed relative to everything else that was already there. The
    focus task is highlighted.
  - **Production traces: only the part of the tree the run touched.** That is every created or
    updated task, plus its ancestors up to the run's root task, with ancestors the run never read
    shown by id.
  - **Changes in either case.** Each changed node is marked added, changed, cancelled, or moved. A
    `parentTaskId` change draws the node under its new parent, with a ghost under the old one.
    Changed fields show a diff (`<TextDiff>` for title and description). Clicking a node selects
    its span, and with several changes, the latest.
- **`applies`** is true when the run seeded any `seededTask` instance *or* made a task call. Even a
  run that created nothing gets the tab, since "it left the tree alone" is worth seeing for a
  planning prompt.

## G. What this sets up for runtime evals

Nothing in this spec runs a check on a production trace. These are the pieces it puts in place so
that doing so later is an addition, not a redesign:

- **Trace-pure checks are already identifiable.** A check whose `inputs` contain no resource is a
  function of the trace and its bound parameters. That is decidable from the declaration, and the
  registry already partitions `inputs` into deps and params. Record it on `CheckInfo` as
  `tracePure: boolean` when online evals are designed, not now. An online eval can only offer
  those checks.
- **One derivation, two consumers.** `taskChanges(trace)` feeds the Tasks tab and can feed a
  check, "no task was reparented outside the run's root", which then runs on production traces
  unchanged. Document the pattern in the visualizers guide: put the derivation in a shared module,
  keep server-only code out of it, and let checks and visualizers both import it.
- **App-side capture is the production producer.** E.2 and its general form are the only producers
  that work online. Making them the recommended way to feed a visualizer now means apps that adopt
  visualizers already emit what online evals will need.
- **Trace-helper modules must stay browser-safe.** `evalution/checks` is now imported by browser
  modules, so a test bundles it for `platform: "browser"` and fails if a Node import creeps in.
  If that becomes hard to maintain, move the helpers to `evalution/trace` and re-export them.

Still undecided, and left to the online-evals design: where online checks run, how traces are
sampled, how results attach to production traces, and whether a dataset row can be derived from
one (`resource-observation.md` §G–§H).

## H. Phasing

1. **Registry and frame document.** The `Surface` descriptor and the trace surface, `traceView()`,
   `VIEW_TAG`, discovery under `.evalution/views/<surface>/`, the per-file esbuild build
   (lazy-loaded), the frame route with its CSP, and `/api/views`, rebuilding on change. Unit tests
   against `MemoryFileProvider`. The generic layer is tested against a toy second surface, so
   nothing trace-specific leaks into it before datasets need the seam.
   These include a file that imports `node:fs`, and one that imports
   `evalution/views/react` without React installed; each must surface as a module error with
   the message from §B.2. Another test checks that the frame response carries `sandbox`
   (without `allow-popups`) and `default-src 'none'`.
2. **Frame runtime and protocol.** The framework-free runtime in `evalution/views`: the generic
   envelope (including `rev` and `rejected`, unused by traces), the handshake, `applies`
   reporting, `mount`/`update` with error capture, theme properties, and the trace surface's
   `applyStreamEvent` reducer. The message handling on each side is a pure function from
   (state, message) to (state, messages to send), so it is unit-tested without a browser.
3. **Trace view tabs.** Hidden frames, tabs appearing on `applies`, dropping frames that don't apply
   on `trace-end` (and re-mounting them on a late span), `selectSpan` and `context`, the `openUrl`
   confirmation, the host page's `frame-src` and navigation detection, reloads on
   `views-changed`, and the remembered tab.
   Playwright CT for what needs a real browser: a tab appearing mid-stream, a throwing visualizer
   staying contained, a frame failing to `fetch`, and a frame that tries to navigate itself
   (`location`, `<a href>`, `<meta http-equiv="refresh">`) being blocked with no request sent. This
   last test runs in Chromium, Firefox, and WebKit (new `projects` in `playwright.config.ts`).
4. **The React adapter.** `evalution/views/react`: `react()`, its error boundary, and
   `react`/`react-dom` as optional peers kept external by tsdown.
5. **asgard: E.2 on `create_task` and `update_task`.** Check that the `TOOL` span's `output` holds
   the whole return while the next LLM span's input holds only `toModelOutput`'s result. Also check
   which of the two the Conversation tab shows, and decide whether that is right. Check that a
   dataset row's run records `resources` with receipts on its root span, which E.1's seed depends
   on.
6. **asgard: the Tasks tab** (§F).
7. **Building blocks** (§B.4), driven by what the Tasks tab ended up writing for itself.
8. *(later, with evalution-cloud)* Serving frames from a user-content origin, getting bundles there,
   and showing each visualizer's author (§B.3, §J.2).
9. *(later)* The app-side span annotation convention, and the native integration's `executeTool`
   wrapper that it needs (§E.2, §J.1).
10. *(later, with online evals)* `CheckInfo.tracePure`, and checks run against ingested traces (§G).
11. *(parked)* `observe()` per `resource-observation.md`, writing into the §E.3 shape.
12. *(when wanted)* A dataset surface (§A.1), most likely `dataset-row` first. This is the first
    surface with effectful actions, so it brings the host-rendered Save/Discard bar and the `rev`
    check into use.

Steps 1–6 deliver the ask. Step 5 is independent of the rest and can land first, because it makes
the Spans tab more useful on its own.

## I. Files

- `src/views/view.ts`: `ViewDefinition`, `ViewProps`, `MountedView`, `VIEW_TAG`, `isView`.
- `src/views/surface.ts`: the `Surface` descriptor type (§A.1).
- `src/views/surfaces/trace.ts`: the trace surface: `traceView()`, `TraceViewProps`, its
  subject, events, finality, and `selectSpan`. Each new surface adds a file here.
- `src/views/protocol.ts`: the generic envelope and `protocol` version, imported by both sides.
- `src/views/runtime.ts`: the frame side, which handles the handshake, keeps the subject through
  the surface's reducer, runs `applies`, calls `mount`/`update` with error capture, and applies the
  theme. It imports no framework and knows no surface by name.
- `src/views/index.ts`: the `evalution/views` entry (`package.json` `exports`). It is
  browser-safe and has no framework imports. Bundles resolve it to the running evalution's copy.
- `src/views/react/index.tsx`: the `evalution/views/react` entry, with `react()` and the
  building blocks.
- `src/views/host.ts`: the host side of the protocol, apart from the DOM: `ViewChannel`, which
  holds what every frame on a surface instance is told, and `hostReceive`, a pure function from a
  frame's message to the host's reply.
- `src/shared/view-surfaces.ts`: the surface names and the frame route, which the server needs
  without the browser-side descriptors.
- `src/server/view-registry.ts`: discovery, the per-file esbuild build,
  `FileProvider`-backed loading, and errors (`ViewModuleError` goes in
  `src/shared/types.ts`).
- `src/shared/trace-stream.ts`: `applyStreamEvent`, moved out of `TraceView.tsx`.
  `src/shared/text-diff.ts`: moved from the client for `<TextDiff>`.
- `src/server/api-routes.ts`: `/api/views` and the frame route. `src/server/index.ts`: the
  registry and the watcher.
- `src/client/components/views/use-surface-views.tsx`: one surface instance's frames, tabs, and
  problems, with the drop-and-remount rules of §C.2. `ViewTabs.tsx`: the tab buttons and the
  problems list.
- `src/client/components/views/ViewFrame.tsx`: one frame, the generic host side of the protocol,
  hidden-frame action filtering, and navigation detection. `src/client/components/views/OpenUrlDialog.tsx`:
  the confirmation. They live outside `trace/` because every surface uses them.
- `src/server/index.ts`: the host page's `frame-src` header on the client HTML.
  `src/client/components/TraceView.tsx`: the tabs.
- `package.json`: `esbuild` in `dependencies`. `react` and `react-dom` in `peerDependencies`,
  optional, while staying in `devDependencies` for the client build. The `./views` and
  `./views/react` exports. `tsdown.config.ts`: the new entries, with React external.
- `specs/resource-observation.md`: its status points here (§E.3).

## J. Open questions

1. *Making the `TOOL` span active in native telemetry.* The general form of E.2 needs app code
   inside `execute` to find "its" span. The OTel path probably has it already, which needs
   checking against `@ai-sdk/otel`. The native path would need an `executeTool` wrapper that runs
   `execute` inside an `AsyncLocalStorage` holding the span, plus a way for an OTel-API
   `setAttribute` to reach it. Not needed for asgard.
2. *Where cloud bundles are built, and who may upload them.* The cloud server must not run esbuild
   over user code any more than it runs the code. Most likely, the CLI builds the per-file bundles
   and uploads them along with the project's other artifacts, and the cloud serves the same frame
   document from a user-content origin. Because a deliberate leak over WebRTC is still possible
   (§B.3), upload rights are the actual trust boundary. Whether that is every
   project member or a narrower role is a cloud permissions question. The `protocol` field is what
   lets an uploaded bundle outlive a host upgrade. Decide with `evalution-cloud/PLAN.md`.
3. *Asset exceptions.* A visualizer that wants to show app images (avatars, say) needs an `img-src`
   exception. That exception is also an exfiltration channel, but only to the listed hosts. It
   could be a per-visualizer opt-in declared in `traceView({ … })` and shown to the viewer.
   Nothing is allowed until one is asked for, and `connect-src` stays `'none'` regardless.
4. *Parameters.* A visualizer might want settings ("root task to show from"). Leave them out until
   one does. If they come, they're tab-local UI state inside the frame, not `inputs`, since
   nothing binds them.
5. *Should `applies` see a partial trace?* It does while the run is live, so a visualizer whose tab
   should only appear for finished runs checks `trace.trace.endTime` itself. That is probably
   fine, but worth a sentence in the docs.
6. *What the dataset surface is.* `dataset-row`, `dataset-field`, or `dataset` (§A.1), and whether
   a dataset view is a visualizer, an editor, or a visualizer that can also propose edits. The
   last option falls out of the generic rules for free: a view with no effectful actions is a
   visualizer. Decide when there is a concrete dataset to build it for.
7. *Auto-commit for local editors.* Locally, the author and the viewer are the same person, and
   a Save bar on every edit may be friction. If it is, auto-commit can become a local-only
   setting. In the cloud, the host-rendered confirmation stays.
