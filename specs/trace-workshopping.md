# Plan: Pull Workshop capabilities into Evalution (DB storage, OTLP backend, trace UI)

> **Refreshed 2026-09-07.** The original plan (2026-09-03) was written against the
> pre-refactor trace layer and a Fastify server. Since then commit `cec31c3`
> ("[traces] Native Vercel AI SDK telemetry + trace architecture refactor") landed
> the ingestor/sink split and the Hono migration shipped, which together retire
> several planned steps and change the shape of others. The Turso/Drizzle
> questions have also been settled empirically — see "Verified findings" below.

## Context

Evalution (`~/Projects/evalution`) today is a prompt **playground**. It no longer has a
single OTel-shaped trace path: `TraceProvider` is now a pure *read* interface, the write
side is `TraceSink`, and spans are produced by pluggable `TraceIngestor`s
(`src/trace/trace-ingestor.ts`). Two ingestors exist — `OTelTraceIngestor` (a
`SpanProcessor` feeding OTel spans in) and `VercelAISDKTelemetry` (AI SDK v7 **native**
telemetry, which bypasses OpenTelemetry entirely). Storage is still the in-memory
`MemoryTraceProvider`, streamed to a 433-line `TraceView.tsx` over SSE.

Workshop (`~/OpenSource/workshop`) is an **observability sink**: it receives OTLP traces
from arbitrary external apps over HTTP, persists them to SQLite, and renders them in a much
richer trace UI (waterfall, span tree, JSON/markdown viewers, cost, annotations).

We want three things from Workshop, all of which align with the `evalution-cloud` PLAN
(`~/Projects/evalution-cloud/PLAN.md`) Phase 0 ("Core portability + local DB"):

1. **Persist traces to a database** (Turso/libSQL, replacing `MemoryTraceProvider` as the
   local default; schema + migrations live in OSS, shared verbatim with cloud).
2. **Be an OTLP backend** so production apps — not just the in-process playground — can
   send traces. Accept **both protobuf and JSON** OTLP.
3. **Adopt Workshop's richer trace UI**, including its **annotation system**, adapted to
   Evalution's plain-CSS + `useState` + SSE conventions.

Confirmed decisions: DB = Turso's new SDK `@tursodatabase/sync` (not `@libsql/client`);
OTLP = protobuf + JSON (vendor Workshop's decoder); UI = full port including annotations.

### Architectural constraints (unchanged)
- Everything in the trace/ingestion path must be **Workers-safe**: no `fs`, no
  `process.cwd()`, no Node-only imports.
- **Hono everywhere.** ✅ *Done* — the server is already Hono (`hono` + `@hono/node-server`
  in `package.json`, `src/server/api-routes.ts` builds on `Hono` and `hono/streaming`).
- **Keep SSE as the single live-update wire format everywhere (including Workers).** The
  only client→server action is "create annotation" — a normal POST — so WebSocket's
  bidirectionality is unneeded. **No transport-swappable `TraceStreamSink` abstraction.**
- The real cloud concern is **cross-isolate fan-out**, not the wire format.
  **`TraceProvider.subscribeTrace(traceId, cb)` is the swap seam**: the OSS provider uses
  the in-memory `subscribers` Map in `BaseTraceProvider`; a future cloud provider
  implements `subscribeTrace` over a Durable Object internally, still emitting SSE on the
  wire. The DO lives *inside* a cloud provider, requiring **no** new abstraction in OSS.

---

## What the refactor already did (strike from the plan)

The trace layer landed in a shape that is *better* than what the original plan proposed to
build, so several items are now done or obsolete:

| Original plan item | Status |
|---|---|
| §E 0a.4 migrate Fastify → Hono | ✅ **Done.** Server is Hono; SSE routes use `streamSSE`. |
| §A.3 add `ingestOtlpSpans` to `BaseOTelTraceProvider` + optional interface method + handler 501 | ❌ **Obsolete.** Superseded by `TraceIngestor` — see §A below. |
| §A.4 add `Span.tool = { args, result, isError }` | ✅ **Done differently.** `ToolSpanDetails { toolName, input, output }` already exists in `src/trace/trace-types.ts`; errors ride `span.status`/`span.errorMessage`. Use the existing shape. |
| `BaseOTelTraceProvider` | ➡️ Renamed/split into `BaseTraceProvider` (`src/trace/trace-sink.ts`) + `TraceSink` + `TraceIngestor`. |
| `mergeSpans` living inside the provider | ➡️ Extracted to `src/trace/span-merge.ts`. |
| Span types in `src/shared/types.ts` | ➡️ Moved to dual-licensed `src/trace/trace-types.ts`; `shared/types.ts` re-exports. |
| §B.5 / risk 1: Drizzle + `@tursodatabase/sync` spike | ✅ **Done, passed.** See "Verified findings". Raw-SQL `TraceDao` fallback is no longer needed. |

## Verified findings (2026-09-07)

These were run against the real packages, not inferred.

**Drizzle now has a first-class sync driver.** The sample in the Drizzle docs
(`drizzle-orm/tursodatabase/database`) is from **drizzle-orm 1.0.0-rc**, not the `latest`
tag — `drizzle-orm@0.45.2` has no `tursodatabase` export at all. In `1.0.0-rc.4` there are
three: `tursodatabase`, `tursodatabase-serverless`, and — the one we want —
**`drizzle-orm/tursodatabase-sync`**, whose `drizzle({ client })` types `client` as the
`Database` from `@tursodatabase/sync` directly. So we do *not* need to smuggle a sync
client into the non-sync driver; there is a supported driver for exactly our case. (The
reason both work: `@tursodatabase/database`'s and `@tursodatabase/sync`'s `Database`
classes both extend the same `DatabasePromise` from `@tursodatabase/database-common`.)

**The spike passed end-to-end** against `@tursodatabase/sync@0.7.2` +
`drizzle-orm@1.0.0-rc.4`: `connect()` with a deferred URL → `drizzle({ client, schema })`
→ `exec()` multi-statement DDL → typed `insert`/`select` → **`onConflictDoUpdate`** (the
merge primitive `addOrUpdateSpan` needs) → transaction **rollback** and **commit** all
behaved correctly. Risk 1 from the original plan is retired.

**Turso deferred sync (your point 3) is right in substance, different in API.** There is
**no public `bootstrapIfEmpty` option** in `DatabaseOpts` at 0.7.2. It's an internal flag
the SDK derives for you:

```js
// @tursodatabase/sync/dist/promise.js
bootstrapIfEmpty: typeof opts.url != "function" || opts.url() != null,
```

So the way you get "local DB now, cloud later" is to pass **`url` as a function** that
returns `null` until signup — documented in `DatabaseOpts` as: *"you can also provide
function which will return URL or null; in this case local database will be created and
sync will be 'switched-on' whenever the url will return non-empty value."* Verified
behaviour:
- `authToken` (also a function) is **not called until a sync operation** — 0 calls after
  connect + local writes, 1 call after `push()`. Your assumption was correct.
- The URL function is re-read live: flipping `null` → a URL makes the next `push()` hit the
  network (`POST /v2/pipeline`, `Authorization: Bearer …`) with **no reconnect**.
- Local writes accumulate as CDC ops while sync is paused (`stats().cdcOperations` grew to
  16), so they are queued to push up on first sync — which is what makes your step 3 work.
- `push()` while the URL is null fails cleanly: `"url is empty - sync is paused"`.
- ⚠️ **Caveat:** the docs note *"all other parameters (like encryption) must be set in
  advance in order for the 'deferred' sync to work properly"* — so `remoteEncryption` (and
  friends) must be decided at **first local connect**, before the user has signed up.
  Decide the encryption posture now, not at signup.
- Not verifiable locally: the cloud half of your step 3 (that pushing into a freshly
  created empty remote DB reproduces schema + data there). Their engineer confirmed it;
  it stays an integration test to run once against a real account.

**Migrations must stay hand-rolled, but can reuse Drizzle's engine.**
`drizzle-orm/tursodatabase-sync/migrator`'s `migrate()` calls `readMigrationFiles()`, which
imports `node:fs` — unusable under Workers. However **`migrateAsync(migrations, db,
config)` is publicly importable** from `drizzle-orm/sqlite-core/async/session` and takes a
pre-read `MigrationMeta[]`. So we bundle the generated migrations into a TS array at build
time and hand them to `migrateAsync` — fs-free, and we inherit Drizzle's ledger table
(`__drizzle_migrations`), hash comparison, and transactional apply instead of hand-writing
them. This is a strict improvement on the original §B.3.

**Residual cost:** this all requires **drizzle-orm 1.0.0-rc.4** (pre-release). That
replaces the old "beta/undocumented combo" risk with a "pinned RC" risk — see Risks.

**Workshop moved v0.1.15 → v0.1.21** (pulled today; upstream's last commit is 2026-08-22).
Nothing structural changed in the port targets, but three deltas matter:
- `src/parse.ts` gained two token-attribute fallbacks: `gen_ai.usage.prompt_tokens` and
  `gen_ai.usage.completion_tokens`. Fold into `readLLM`.
- `src/db/schema.ts` only gained `runs.display_name`; the **`annotations` table is
  unchanged**, so the §B.1 port target is still exact.
- `src/spans/adapters/ai-sdk.ts` gained `hasImageContent()` — messages carrying an `image`
  part (or a `file` part with an `image/*` mediaType) are now **kept** even with no text.
  Workshop's `MessageList`/`messageParsing` grew ~165 lines to render them. **This is a
  real gap in Evalution**, and a new one: see §A.5.
- Workshop is **Bun**-based (`bun:sqlite`, `drizzle-orm/bun-sqlite`, express + ws), so
  there is no Turso precedent to copy from it. In particular its migration strategy
  (extract embedded migrations to a temp dir, then `readMigrationFiles`) is exactly what we
  must **not** copy.
- `decodeOtlpProtobuf` is `Uint8Array`-clean apart from a `Buffer` in one type signature —
  trivially portable.

---

## Key findings that shape the approach

- **Ingestion is now a plugin point, not a provider method.** `TraceIngestor`/
  `BaseTraceIngestor` (`src/trace/trace-ingestor.ts`) translate an upstream signal into
  normalized `Span`s and fan them out to every attached `TraceSink`. `BaseTraceProvider`
  implements `TraceSink` and owns root detection, trace creation, merge, and event
  emission. **OTLP becomes a third ingestor**, storage-agnostic and provider-agnostic.
- **There are now three span provenances**, and they do not agree on shape:
  1. `OTelTraceIngestor` — OTel attribute bags, `attributes` fully populated.
  2. `VercelAISDKTelemetry` — **native v7, no OTel and no `attributes` at all**; builds
     `Span`s directly with a fixed topology (`AGENT` root → `LLM` `step: N` → `TOOL`
     children keyed by `toolCallId`).
  3. *(new)* OTLP over HTTP — attribute bags from arbitrary external SDKs.
  This makes the UI's `SpanViewModel` adapter (§D) more load-bearing than originally
  scoped: it must render a span with rich `llm`/`tool` and **zero** `attributes` just as
  well as an attribute-heavy Traceloop span.
- **The attribute extractors are shared by two of three paths, not all three.**
  `readKind`, `readLLM`, `llmAndPrompt`, `mapStatus`, `parseMessages`, `parseOutput`,
  `readInputs` are module-level functions in `src/trace/otel-trace-ingestor.ts`. Extracting
  them (§A.1) is still right, but the framing changes: they are the **OTLP + OTel** rules,
  not universal ones. The native path bypasses them by construction.
- **`SpanMessage.content` is `string`** (`trace-types.ts`), so image/file content parts
  cannot be represented at all today — both producers silently lose them
  (`parseMessages` drops image-only messages entirely; `toSpanMessages` keeps the message
  with empty content). Workshop now renders them. See §A.5.
- **Ingestor de-duplication has a new case.** `isRedundant` currently only handles
  OTel-vs-OTel. An app that both registers native v7 telemetry *and* exports OTLP to us
  would double-record; `VercelAISDKTelemetry.shouldDeferGlobally()` only knows about
  in-process OTel integrations, not a remote collector.
- **Provider bootstrap lives in `src/cli/index.ts:86-101`**, not `config.ts` — adapters
  return ingestors from `setupTraceIngestion()`, redundant ones are dropped, and
  `new MemoryTraceProvider({ ingestors })` is constructed. That is the single line to
  change for the default swap (§B.4).

---

## A. OTLP ingestion → a third `TraceIngestor`

**Approach: an `OtlpTraceIngestor extends BaseTraceIngestor`.** OTLP arrives as a batch of
already-finished spans (no start/end lifecycle, no causal ordering guarantee). Fabricating
`ReadableSpan`s to push through a `SpanProcessor` would be two lossy conversions; adding an
`ingestOtlpSpans` method to the provider (as originally planned) would now be redundant
with the ingestor seam that already exists. An ingestor gets storage-independence for
free: it works against `MemoryTraceProvider` in tests and `TursoTraceProvider` in
production with no code change, and it composes with the other two ingestors.

1. **Extract shared extractors** out of `otel-trace-ingestor.ts` into a new pure module
   `src/trace/otel-attributes.ts` (`readKind`, `readLLM`, `llmAndPrompt`, `mapStatus`,
   `parseMessages`, `parseOutput`, `readInputs`). No behaviour change. Both the OTel
   ingestor and the new OTLP ingestor call them — one set of "attributes → Evalution Span"
   rules for the two attribute-bearing paths. Keep it dual-licence-clean (it is imported by
   `src/trace/` only).
2. **Vendor Workshop's transport decode only** under `src/trace/otlp/`: `decodeOtlpProtobuf`
   (`workshop/src/otlp-protobuf.ts`) and the `resourceSpans→scopeSpans→spans` walking +
   hex-id / ns→ms / status normalization from `workshop/src/parse.ts`. Stop at a thin
   `NormalizedOtlpSpan = { traceId, spanId, parentSpanId?, name, startTimeMs, endTimeMs?,
   statusCode, statusMessage?, attributes: Record<string,unknown>, events? }` — do **not**
   carry Workshop's `ParsedSpan`/`span_type`/`input_payload` shape across. Widen the one
   `Buffer` type annotation to `Uint8Array`.
3. **`OtlpTraceIngestor`** (`src/trace/otlp-trace-ingestor.ts`): a public
   `ingest(spans: NormalizedOtlpSpan[]): Promise<void>` that maps each span to an Evalution
   `Span` via the §A.1 extractors and calls the inherited `recordSpanEnd` (finished spans;
   `recordSpanStart` only for a span with no `endTimeMs`). `BaseTraceProvider` already
   handles provisional trace creation from a root and `mergeSpans` on re-delivery, so
   out-of-order batches (children before root) need no special casing here — but sort each
   batch parents-first as a cheap optimisation. It reports `isRedundant` for nothing.
4. **Broaden SDK coverage:** port Workshop's multi-SDK **attribute key lists /
   discriminators** (AI SDK, Claude Agent SDK, Traceloop, LiveKit — from
   `workshop/src/spans/adapters/*.ts`) into `readKind`/`readLLM` as additional fallbacks,
   including the two new `gen_ai.usage.{prompt,completion}_tokens` keys, and add tool
   args/result extraction into the **existing** `ToolSpanDetails`. Port the *key lists*,
   not Workshop's `SpanAdapter` class hierarchy. Unknown spans stay `kind:'DEFAULT'` with
   full `attributes` preserved (nothing dropped, only under-typed).
5. **Multi-part message content** *(new)*. Widen `SpanMessage.content` to
   `string | SpanContentPart[]` where `SpanContentPart` covers at least `text` and `image`
   (a URL or data ref + mediaType), and teach **all three** producers to emit it:
   `parseMessages` (stop dropping image-only messages), `toSpanMessages` in
   `src/sdk/vercel-ai-sdk/telemetry.ts` (stop flattening to empty string), and the OTLP
   path (port `hasImageContent`). This is a breaking change to a dual-licensed public type,
   so do it **once, early** — before the UI port consumes it — and keep `string` in the
   union so existing consumers and stored rows keep working.
6. **Neutral handler** `src/server/handlers/otlp-ingest.ts`:
   ```ts
   export interface OtlpIngestDeps {
     resolveIngestor(ctx: { headers: Record<string,string>; auth?: AuthCtx })
       : OtlpTraceIngestor | undefined;
   }
   export async function handleOtlpTraces(
     req: { contentType: string; body: ArrayBuffer; headers: Record<string,string> },
     deps: OtlpIngestDeps,
   ): Promise<{ status: number; body: unknown }>;
   ```
   Branches on `content-type` (`application/x-protobuf` → `decodeOtlpProtobuf`,
   `application/json` → `JSON.parse`), returns OTLP's `{ partialSuccess: {} }` with 200.
   Takes `ArrayBuffer` + plain headers (no `Buffer`/`fs`/`process`).
7. **Routes (Hono):** register `POST /v1/traces` + alias `POST /otel/v1/traces`, reading the
   raw body via `c.req.arrayBuffer()` so protobuf bytes survive.
8. **Target selection** (no `providerId` in OTLP): **local** → the process's single
   `OtlpTraceIngestor`, which is attached as a sink-source to whichever providers the CLI
   built (optionally an `x-evalution-provider` header override to pick one); **cloud** →
   `resolveIngestor` keys off auth (API key → project+environment → that project's
   ingestor bound to that project's provider). The OSS handler stays auth-agnostic.
9. **Double-recording guard** *(new)*: document — and detect where cheap — that an app
   sending OTLP to Evalution while also running native v7 telemetry into the same server
   will record two traces. Extend `isRedundant`/`shouldDeferGlobally` only if it shows up
   in practice; a documented note plus distinct trace ids is acceptable for Phase 0.

## B. Turso persistence

1. **`src/trace/db/schema.ts`** (Drizzle sqlite-core, shared verbatim with cloud). Promote
   to columns what's queried (tree-build, ordering, summary/cost rollups); JSON the
   display-only, variable-shape fields — mirroring Workshop's split.
   - `traces`: `id` PK, `provider_id`, `name`, `start_time` (ms), `end_time`, `status`
     (`running|ok|error`), `attributes` (JSON). Index `start_time desc`.
   - `spans`: `id` PK, `trace_id` (FK, idx), `parent_id` (idx), `name`, `kind`,
     `start_time`, `end_time`, `status`, `error_message`; LLM **columns** `llm_provider`,
     `llm_model`, `llm_prompt_tokens`, `llm_completion_tokens`, `llm_total_tokens`,
     `llm_cost`; **JSON** `llm_messages`, `llm_output`, `llm_parameters`, `attributes`,
     `prompt`, `tool`. (`attributes` is legitimately NULL for native-telemetry spans — do
     not treat that as a defect.)
   - `annotations` (port Workshop's table verbatim, `run_id`→`trace_id`): `id` PK,
     `trace_id` (idx), `span_id` (nullable = trace-level), `kind` (`issue|good|note`),
     `note`, `source` (`user|claude-code|codex`), `created_at`.
   - **Omit `live_events` locally** — Evalution's SSE replays current state from spans on
     connect, so a durable event log is redundant. Revisit only if the cloud Durable Object
     needs a persisted backlog.
2. **`src/trace/turso-trace-provider.ts`**: `TursoTraceProvider extends BaseTraceProvider`
   implementing the six abstract members (`getAllTraces`, `hasTrace`,
   `getTraceWithoutSpans`, `getTraceSpans`, `addOrUpdateTrace`, `addOrUpdateSpan`) plus the
   annotation store. `rowToSpan`/`spanToRow` flatten/reassemble `span.llm.*` (attach `llm`
   only if some LLM column is non-null) and `JSON.parse`/`stringify` blobs. `addOrUpdateSpan`
   uses `INSERT … ON CONFLICT DO UPDATE` (**verified working** in the spike) and must
   return the **merged** span, so it reads existing → `mergeSpans` → writes merged → returns
   merged inside a transaction (also verified). **Constructor takes an injected
   `{ client }`** (a `@tursodatabase/sync` connection) — never a path, so no `fs` in the
   provider. Accept `ingestors` in the constructor exactly as `MemoryTraceProvider` does.
   The Node bootstrap (fs-allowed) builds the file-backed client.
3. **Client bootstrap** *(revised per verified findings)*: a Node-side
   `createLocalTursoClient({ path, getCloudUrl, getAuthToken })` that calls
   `connect({ path, url: () => cloudUrl ?? null, authToken: async () => …, clientName })`.
   Passing `url` **as a function** is what suppresses remote bootstrap; there is no
   `bootstrapIfEmpty` to pass. Neither callback fires until `push()`/`pull()`. Fix
   `remoteEncryption` (even if "none") at this first connect — it cannot be introduced
   later without breaking deferred sync. Cloud sign-up then only has to make the URL
   function start returning a value and call `push()`; no reconnect.
4. **Migrations:** `drizzle.config.ts` (`dialect:'sqlite'`, schema → `src/trace/db/migrations/`),
   generate committed SQL with `drizzle-kit generate`. **Runtime apply must be fs-free** →
   a build step bundles the generated migrations into a TS `MigrationMeta[]`
   (`migrations/bundled.ts`), and `runMigrations(db)` calls **`migrateAsync(bundled, db,
   { migrationsTable })`** imported from `drizzle-orm/sqlite-core/async/session` — reusing
   Drizzle's ledger + transactional apply rather than hand-rolling one. Local first-run and
   cloud provisioning both call it (this is also the PLAN's "local DB forward-migration on
   upgrade" path). Add a test that fails if a file in `migrations/` is missing from
   `bundled.ts`.
5. **Default swap:** in **`src/cli/index.ts:86-101`** (not `config.ts`), when
   `config.traceProviders` is omitted, build the Turso client and instantiate
   `TursoTraceProvider({ ingestors })` instead of `MemoryTraceProvider({ ingestors })`.
   Generalize the `traceProviders.find(p => p instanceof MemoryTraceProvider)` default-pick
   in `src/server/index.ts:81` to be provider-agnostic (it exists only to prefer the
   built-in provider; make it "the one the CLI built" instead). Keep `MemoryTraceProvider`
   exported for tests/ephemeral use, and update the `config.ts:52` doc comment.
6. **Dependencies:** add `@tursodatabase/sync@^0.7.2` and pin
   `drizzle-orm@1.0.0-rc.4` exactly (see Risks), plus `drizzle-kit` as a dev dep. Run
   `npm run docs` after — `TursoTraceProvider` and its options are public API.

## C. Live updates — Hono SSE on the existing provider seam (no transport abstraction)

`subscribeTrace(traceId, cb)` is already the swap seam. The Hono migration is done, so the
remaining work is only to lift the SSE body out of the route and broaden the event union so
annotations ride the same stream.

1. **One neutral SSE handler** `src/server/handlers/trace-stream.ts` — `streamTrace(provider,
   traceId): ReadableStream` (or a `streamSSE` callback). Move the replay-existing-state
   logic out of the current route (`src/server/api-routes.ts:410-452`), then subscribe via
   `provider.subscribeTrace` **and** the annotation subscription. Keep the existing
   prompt-resolution step (`resolveEvent`) that maps a stream event's span back to a
   concrete prompt — it must survive the move. A cloud DO-backed provider implements
   `subscribeTrace` over a Durable Object internally; this handler is unchanged.
2. **Broaden the live union** in `src/trace/trace-types.ts` (re-exported from
   `shared/types.ts`):
   ```ts
   type TraceLiveEvent = TraceStreamEvent
     | { type: 'annotation'; op: 'insert' | 'delete'; annotation: Annotation };
   ```
   Add an annotation subscriber set + `subscribeAnnotations(traceId, cb)` + `emitAnnotation`
   to `BaseTraceProvider` (paralleling the existing `subscribers` Map), called by the
   annotation REST handlers after a DB write. One in-process fan-out; annotations stream
   over the SSE connection the trace view already holds open.

## D. UI port (full, incl. annotations)

New components under `src/client/components/trace/`, adapted to Evalution conventions:

| Workshop | New Evalution | Adaptation |
|---|---|---|
| `FlameTimeline.tsx` | `FlameTimeline.tsx` | reuse `TraceView`'s existing `buildRows`/`computeWindow` (`TraceView.tsx:221,244`); CSS-token bars |
| `SpanTree.tsx` | `SpanTree.tsx` | merge with `buildRows` |
| `JsonView.tsx`, `Markdown.tsx`, `MessageList.tsx`, `ChatFlow.tsx` | same names | Tailwind→CSS tokens; `MessageList` reads `LLMSpanDetails.messages` **including the new multi-part content from §A.5**; `ChatFlow` wired to SSE |
| `utils/messageParsing.ts` (image content parts) | folded into `MessageList` | new since the last plan revision; needed for §A.5 to be visible |
| `AnnotationChip.tsx`, `TraceAnnotations.tsx` | same names | `KIND_STYLES`/`SOURCE_GLYPH` → CSS classes |
| `utils/helpers.ts`, `utils/costs.ts`, `spanColor` | port directly | `costs.ts` fills `LLMSpanDetails.cost` client-side if unset |
| `hooks/use-annotations.ts` (React Query) | `hooks/useAnnotations.ts` | rewrite as `useState` + fetch, optimistic create/delete, port `freshIds` arrival animation |
| `hooks/use-workshop-ws.ts` (WebSocket) | folded into `subscribeTraceEvents` | drop WS; surface `{type:'annotation',…}` on the existing per-trace EventSource |

**Mechanical adaptation rules:** Tailwind/`C.*` inline styles → semantic classNames backed by
`styles.css` design tokens (map Workshop's dark-only palette to Evalution's light/dark token
pairs; add annotation kind colors); Radix primitives → the plain elements Evalution already
uses; React Query → `useState`+`useEffect` mirroring existing `usePrompts`/`useTraces`.

**Span-shape adapter** `src/client/components/trace/spanViewModel.ts`: a `SpanViewModel`
(Workshop-flavored field names: `spanType`, `startMs`, `messages`, `toolArgs`, …) + a single
`toSpanViewModel(span: Span): SpanViewModel`. Ported components consume `SpanViewModel`;
this isolates the Workshop↔Evalution divergence to one file. **It must be exercised against
all three provenances** (OTel, native v7, OTLP) — in particular a native-telemetry span has
no `attributes` and a Workshop component that assumes `input_payload`-style strings will
render empty. Build fixture spans for each and snapshot them.

`TraceView.tsx` becomes the composition root (FlameTimeline + TraceAnnotations +
selected-span detail), **keeping its current props** (`providerId`, `traceId`,
`initialSpanId`, `onOpenPrompt`) so `App.tsx`'s trace tab needs no change.

**Annotation REST** — neutral handlers in `src/server/handlers/annotations.ts`:
- `GET /api/traces/:providerId/:traceId/annotations` → `listAnnotations`
- `POST .../annotations` → `createAnnotation` then `emitAnnotation(… 'insert')`
- `DELETE .../annotations/:id` → `deleteAnnotation` then `emitAnnotation(… 'delete')`

Storage = the §B `annotations` table; UI inserts default `source:'user'`; agent sources
(`claude-code`/`codex`) come from external callers and trigger the arrival animation.

## E. Sequencing & risks

**All of A–D is OSS Phase 0 work.** Order (0a.1 and 0a.4 from the original plan are done):

- **0a Foundations** — (1) ~~Drizzle spike~~ ✅ **passed**, adopt
  `drizzle-orm/tursodatabase-sync`; (2) confirm `protobufjs`/`decodeOtlpProtobuf` bundle &
  run under `workerd`; (3) extract shared extractors → `src/trace/otel-attributes.ts`
  (no-behaviour-change refactor); (4) ~~Fastify→Hono~~ ✅ **done**; (5) **§A.5 multi-part
  `SpanMessage.content`** — do this early, it touches a dual-licensed public type and all
  three producers.
- **0b Persistence** (needs 0a.1): schema + bundled migrations + `runMigrations` via
  `migrateAsync`; `TursoTraceProvider`; local client bootstrap with the deferred-URL
  function. Acceptance test = run `src/trace/memory-trace-provider.test.ts`'s suite against
  `TursoTraceProvider` (same abstract contract) — must pass identically. Then wire as the
  CLI default.
- **0c OTLP ingestion** (needs 0a.2/0a.3; storage-agnostic → parallel to 0b): vendor
  decoder → `NormalizedOtlpSpan`; `OtlpTraceIngestor` (testable against
  `MemoryTraceProvider` first); `handleOtlpTraces` + routes + raw-body handling; multi-SDK
  key lists + tool extraction.
- **0d Live updates** (needs 0c for the event union): move the SSE replay/stream logic into
  the neutral `streamTrace` handler; add annotation subscribers + broadened
  `TraceLiveEvent`. (No transport abstraction — `subscribeTrace` is the seam.)
- **0e Annotations** (needs 0b table + 0d broadcast): provider methods + REST handlers →
  `emitAnnotation`.
- **0f UI port** (needs 0d + 0e): components + `SpanViewModel` adapter + CSS/fetch/SSE
  adaptations; replace `TraceView` internals; annotation client + `useAnnotations`.

Cloud (evalution-cloud) is a thin wrapper over the seams designed here: its own
`resolveIngestor` from auth; a cloud `TraceProvider` whose `subscribeTrace` is backed by a
Durable Object for cross-isolate fan-out (still SSE on the wire); its own bootstrap building
a synced-replica client — not Phase 0, but the seams (the handler deps, the injected
`{client}`, and the `subscribeTrace` interface) must exist now.

**Top risks / mitigations:**
1. *~~Drizzle + `@tursodatabase/sync`~~* — **retired by the spike.** Replaced by:
   **drizzle-orm 1.0.0-rc.4 is a pre-release.** The `tursodatabase-sync` driver does not
   exist in `latest` (0.45.2), so there is no stable fallback that keeps the typed path.
   Mitigate by pinning the exact version (no `^` — already done in `package.json`), keeping
   all DB access behind `TursoTraceProvider` so a driver swap is one file, and relying on
   the `src/trace/db/*.test.ts` contract tests to fail loudly on any bump. The 1.0 RC also
   changes Drizzle APIs generally — this is the first Drizzle use in the repo, so there is
   no existing code to migrate.
2. *Turso deferred-sync parameters are fixed at first connect* — `remoteEncryption` and
   friends must be chosen before signup; changing them later means re-bootstrapping the
   local DB. Decide the encryption posture during 0b.
3. *Cloud push-to-empty-DB is unverified locally* — the local half is proven; schedule one
   integration test against a real Turso account before the cloud phase depends on it.
4. *Protobuf on Workers* — smoke-test early; the JSON path ships independently;
   `@bufbuild/protobuf` behind the same `decodeOtlpProtobuf` interface as backup.
5. *OTLP attribute coverage across SDKs* — port Workshop's key lists (not its adapter class
   hierarchy); unknown → `DEFAULT` with attributes preserved; add per-SDK fixture tests.
6. *Three-provenance UI divergence* — single `toSpanViewModel` adapter, fixture-tested
   against OTel, native-v7 (no `attributes`), and OTLP spans.
7. *fs-free constraint* — bundled migrations via `migrateAsync` (no runtime `fs`); injected
   `{client}` (path resolution stays in the Node bootstrap); audit the vendored decoder for
   `Buffer`/`process`; CI bundle check over the Workers-safe `./core` export.
8. *OTLP batch ordering (root after children)* — `BaseTraceProvider`'s existing provisional
   trace creation + `mergeSpans` tolerance; trace `status`/`name` corrected when the root
   lands. Sort batches parents-first as an optimisation.

## Critical files

- `src/trace/trace-ingestor.ts` — the seam OTLP plugs into (no change expected)
- `src/trace/trace-sink.ts` (`BaseTraceProvider`) — annotation subscribers + `emitAnnotation`
- `src/trace/otel-trace-ingestor.ts` — extractors move out
- `src/trace/otel-attributes.ts` *(new)* — shared attribute→Span extractors
- `src/trace/otlp/` *(new)* — vendored OTLP protobuf/JSON decoder → `NormalizedOtlpSpan`
- `src/trace/otlp-trace-ingestor.ts` *(new)* — the third ingestor
- `src/trace/turso-trace-provider.ts` *(new)* + `src/trace/db/schema.ts`, `migrations/` *(new)*
- `src/trace/trace-types.ts` — multi-part `SpanMessage.content`, `Annotation`, `TraceLiveEvent`
- `src/sdk/vercel-ai-sdk/telemetry.ts` — `toSpanMessages` multi-part content
- `src/server/handlers/otlp-ingest.ts`, `trace-stream.ts`, `annotations.ts` *(new)*
- `src/server/api-routes.ts` — register `/v1/traces` + annotation routes; lift the trace SSE
  body (lines 410-452) into the neutral handler
- `src/cli/index.ts` (lines 86-101) — default-provider swap + Turso client bootstrap
- `src/server/index.ts` (line 81) — provider-agnostic default pick
- `src/client/components/trace/*` + `TraceView.tsx`, `src/client/api.ts`,
  `src/client/hooks/useAnnotations.ts`

## Verification

- **Driver contract:** ✅ done and **kept as tests** —
  `src/trace/db/turso-drizzle-contract.test.ts` covers `drizzle({ client })` over a
  `@tursodatabase/sync` connection (DDL, typed CRUD, `onConflictDoUpdate`, transaction
  rollback/commit) plus the fs-free `migrateAsync` path (first apply, idempotent re-apply,
  forward-migration). Runs in `npm test`, so a dependency bump that breaks the pinned RC
  fails the build.
- **Deferred sync:** ✅ done and **kept as tests** —
  `src/trace/db/turso-deferred-sync.test.ts` covers the local-only bootstrap, credential
  callbacks not firing until a sync op, writes queuing as CDC operations, a clean failure
  when pushing while signed out, and live switch-on when the URL callback starts returning
  a value (asserted against a loopback recorder). ⏳ still to do: one push against a real
  empty cloud DB — that half needs an account and stays out of `npm test`.
- **Provider parity:** run the existing `memory-trace-provider.test.ts` suite against
  `TursoTraceProvider` (same abstract contract) — must pass identically.
- **Migrations:** the mechanism is covered by the contract tests above; still to add once
  real migrations exist — a test that every file in `migrations/` appears in `bundled.ts`.
- **OTLP ingest:** `curl --data-binary @fixture.pb -H 'content-type: application/x-protobuf'
  POST /v1/traces` and the JSON equivalent; assert the trace appears via `GET /api/traces/…`
  with correct kinds/tokens/tool args; add per-SDK fixtures (AI SDK, Claude Agent SDK,
  Traceloop, LiveKit) captured from Workshop's corpus.
- **Three-provenance parity:** one prompt run recorded via native v7 telemetry, one via the
  OTel fallback, one ingested over OTLP — all three render correctly through
  `toSpanViewModel` (unit test on the adapter, Playwright CT on the rendered rows).
- **Live stream:** open the trace SSE, POST spans, assert `span-start`/`span-end`/`trace-end`
  arrive; create/delete an annotation and assert the `annotation` event reaches the open
  stream and the UI updates without refresh.
- **UI:** `npm run dev`, run a playground prompt + ingest a production OTLP trace, confirm
  the ported waterfall/tree/JSON/markdown/cost render, image content parts display, and
  annotations can be added on traces + spans.
- **Workers-safe:** CI esbuild `--platform=browser` (or `wrangler`) smoke-build of the
  `./core` export to catch `fs`/`process`/`Buffer` regressions.
- Per `CLAUDE.md`: `npm run typecheck`, `npm test`, `npm run test:ui` for UI behaviour, and
  `npm run docs` (warning-free) after the public-API changes in §A.5 and §B.
