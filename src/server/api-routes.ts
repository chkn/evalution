// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  isSpanContextValid,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import {
  resolveExecutionInputs,
  stampReceipts,
} from "../prompt/execution-inputs.ts";
import {
  type OpenOnHeadOptions,
  type PromptProvider,
  type ResolvedPromptInputs,
  VariationConflictError,
} from "../prompt/prompt-provider.ts";
import type { PromptRegistry } from "../prompt/prompt-registry.ts";
import { isPromptStyle } from "../shared/helpers.ts";
import type { SetupTask } from "../shared/setup-task.ts";
import type {
  ExecuteRequest,
  ExecuteResponse,
  PromptRef,
  Span,
  SSEData,
  UpdatePromptResponse,
} from "../shared/types.ts";
import type { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import {
  type AnnotationHandlerResult,
  handleCreateAnnotation,
  handleDeleteAnnotation,
  handleListAnnotations,
} from "./handlers/annotations.ts";
import {
  type DatasetHandlerResult,
  handleAddRows,
  handleCreateDataset,
  handleDeleteDataset,
  handleDeleteRow,
  handleGetDataset,
  handleListDatasets,
  handleListRows,
  handleRenameDataset,
  handleUpdateRows,
  type ResolvePromptLink,
} from "./handlers/datasets.ts";
import { handleOtlpTraces } from "./handlers/otlp-ingest.ts";
import { streamTrace } from "./handlers/trace-stream.ts";

/** Decodes a URL-safe base64 prompt id produced by `encodePromptId`. Uses the
 * Web `atob` (rather than Node's `Buffer`) so it works in browser/worker
 * bundles too. */
function decodePromptId(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

/**
 * The {@link PromptRef} a prompt route names: head, unless the request carries
 * `?version=` or `?variation=`.
 */
function promptRefFrom(c: Context, promptId: string): PromptRef {
  const variation = c.req.query("variation");
  if (variation) return { promptId, variation };
  const version = c.req.query("version");
  if (version) return { promptId, version };
  return { promptId };
}

/**
 * The response for an error from a versions or variations call: a conflict is
 * a 409 carrying the conflicting fields, so the client can show them.
 */
function errorResponse(c: Context, error: any, status: ContentfulStatusCode) {
  if (error instanceof VariationConflictError) {
    return c.json({ error: error.message, conflicts: error.conflicts }, 409);
  }
  return c.json({ error: error?.message ?? String(error) }, status);
}

/**
 * Onboarding setup-task handling, injected by the host so the route module
 * carries no filesystem dependency. The Node CLI passes the fs-backed
 * implementation from `./setup-tasks.ts`; runtime-neutral hosts (e.g. the
 * browser/service-worker bundle) omit it and the routes report "no tasks".
 */
export interface SetupTaskHandlers {
  resolve(rootPath: string): { agent: SetupTask[]; sdk: SetupTask[] };
  executeStep(
    rootPath: string,
    taskId: string,
    stepId: string,
  ): Promise<{ path?: string }>;
}

export interface SetupRoutesOptions {
  app: Hono;
  promptProviders: Map<string, PromptProvider>;
  traceProviders: Map<string, TraceProvider>;
  /** Dataset stores. Omitted by hosts with none; the routes then list nothing. */
  datasetProviders?: Map<string, DatasetProvider>;
  promptRegistry: PromptRegistry;
  /** Registry of hot-reload SSE writers; each `/api/events` client adds one. */
  hotReloadSubscribers: Set<(data: SSEData) => void>;
  rootPath: string;
  /** Whether the server was started with a project config file loaded. */
  hasConfig: boolean;
  tracer: Tracer;
  defaultTraceProviderId: string;
  /**
   * Optional onboarding setup-task handlers. When omitted, the setup-task
   * routes report no tasks / 404 (used by hosts without a filesystem).
   */
  setupTasks?: SetupTaskHandlers;
  /**
   * When set, `POST /api/prompts/:p/:id/execute` short-circuits and returns this
   * message as a 400 error instead of running the prompt. Used by the in-browser
   * demo, where execution happens locally via `npx evalution`.
   */
  executeDisabledMessage?: string;
  /**
   * The process's OTLP ingestor, if any. When set, `POST /v1/traces` (and the
   * `/otel/v1/traces` alias) accept incoming OTLP trace exports and feed them
   * to it. Omitted hosts (e.g. the in-browser demo) simply don't expose the
   * route's functionality — `resolveIngestor` always returns `undefined`.
   */
  otlpIngestor?: OtlpTraceIngestor;
}

export function setupRoutes({
  app,
  promptProviders,
  traceProviders,
  datasetProviders = new Map(),
  promptRegistry,
  hotReloadSubscribers,
  rootPath,
  hasConfig,
  tracer,
  defaultTraceProviderId,
  setupTasks,
  executeDisabledMessage,
  otlpIngestor,
}: SetupRoutesOptions) {
  // Resolve a span's prompt reference (which may be a global ID) to a concrete
  // provider-scoped prompt the client can open. Done at read time against the
  // current registry so the stored raw ID stays stable across renames/moves.
  const resolveSpanPrompt = (span: Span): Span => {
    if (!span.prompt) return span;
    const resolved = promptRegistry.resolve(
      span.prompt.id,
      span.prompt.providerId,
    );
    if (!resolved) return span;
    // Only the reference is rewritten: the recorded inputs and definitions
    // ride along, since they're what "Open prompt" fills the panel from.
    return {
      ...span,
      prompt: {
        ...span.prompt,
        id: resolved.promptId,
        providerId: resolved.providerId,
      },
    };
  };

  // GET /api/config - Get server configuration
  app.get("/api/config", c => c.json({ rootPath, configured: hasConfig }));

  // GET /api/setup-tasks - Onboarding tasks (with per-step completion status)
  app.get("/api/setup-tasks", c =>
    c.json(setupTasks ? setupTasks.resolve(rootPath) : { agent: [], sdk: [] }),
  );

  // POST /api/setup-tasks/:taskId/steps/:stepId/execute - Run one onboarding step
  app.post("/api/setup-tasks/:taskId/steps/:stepId/execute", async c => {
    if (!setupTasks) {
      return c.json({ error: "Setup tasks are not available" }, 404);
    }
    const { taskId, stepId } = c.req.param();
    try {
      return c.json(await setupTasks.executeStep(rootPath, taskId, stepId));
    } catch (error: any) {
      // SetupStepNotFoundError sets `.name`; map it to 404, others to 400.
      const status = error?.name === "SetupStepNotFoundError" ? 404 : 400;
      return c.json({ error: error.message }, status);
    }
  });

  // GET /api/providers - List providers with display info
  app.get("/api/providers", c =>
    c.json(
      Array.from(promptProviders.entries()).map(([id, provider]) => ({
        id,
        displayName: provider.displayName,
        description: provider.description,
        icon: provider.icon,
        hasAddPrompt: !!provider.addPrompt,
        hasVersions: !!provider.versions,
        hasVariations: !!provider.variations,
      })),
    ),
  );

  // POST /api/providers/:providerId/add-prompt - Create a new prompt
  app.post("/api/providers/:providerId/add-prompt", async c => {
    try {
      const { providerId } = c.req.param();
      const provider = promptProviders.get(providerId);
      if (!provider) {
        return c.json({ error: "Provider not found" }, 404);
      }
      if (!provider.addPrompt) {
        return c.json(
          { error: "This provider does not support adding prompts" },
          405,
        );
      }
      const result = await provider.addPrompt(await c.req.json());
      // Distinguish created prompt (has `id`) from context (has `fields`)
      if ("fields" in result) {
        return c.json(result);
      }
      return c.json({ ...result, providerId });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  // GET /api/providers/:providerId/model-definition?style=chat|questions
  app.get("/api/providers/:providerId/model-definition", async c => {
    const { providerId } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }
    const style = c.req.query("style") ?? "chat";
    if (!isPromptStyle(style)) {
      return c.json({ error: `Unknown prompt style "${style}"` }, 400);
    }
    return c.json((await provider.getModelDefinition?.(style)) ?? null);
  });

  // GET /api/providers/:providerId/model-parameters
  app.get("/api/providers/:providerId/model-parameters", async c => {
    const { providerId } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }
    return c.json(provider.getModelParameters?.() ?? []);
  });

  // GET /api/prompts - Get all prompts from all providers
  app.get("/api/prompts", async c => {
    try {
      const results = await Promise.all(
        Array.from(promptProviders.entries()).map(
          async ([providerId, provider]) => {
            const prompts = await provider.getAllPrompts();
            return prompts.map(prompt => ({ ...prompt, providerId }));
          },
        ),
      );
      return c.json(results.flat());
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/prompts/:providerId/:id - Get specific prompt
  app.get("/api/prompts/:providerId/:id", async c => {
    try {
      const { providerId, id } = c.req.param();
      const provider = promptProviders.get(providerId);
      if (!provider) {
        return c.json({ error: "Provider not found" }, 404);
      }

      const decodedId = decodePromptId(id);
      const prompt = await provider.getPrompt(promptRefFrom(c, decodedId));
      if (!prompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      return c.json({ ...prompt, providerId });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/prompts/:providerId/:id/versions?limit=&before= - Versions that
  // changed this prompt's file, newest first
  app.get("/api/prompts/:providerId/:id/versions", async c => {
    const { providerId, id } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    if (!provider.versions) {
      return c.json({ error: "This provider has no versions" }, 405);
    }
    try {
      const limit = Number(c.req.query("limit"));
      return c.json(
        await provider.versions.history(decodePromptId(id), {
          ...(Number.isInteger(limit) && limit > 0 && { limit }),
          ...(c.req.query("before") && { before: c.req.query("before") }),
        }),
      );
    } catch (error: any) {
      return errorResponse(c, error, 500);
    }
  });

  // GET /api/prompts/:providerId/:id/variations - Named variations and WIPs
  app.get("/api/prompts/:providerId/:id/variations", async c => {
    const { providerId, id } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    if (!provider.variations) {
      return c.json({ error: "This provider has no variations" }, 405);
    }
    try {
      return c.json(await provider.variations.list(decodePromptId(id)));
    } catch (error: any) {
      return errorResponse(c, error, 500);
    }
  });

  // POST /api/prompts/:providerId/:id/open-on-head?version= - Bring an old
  // version's prompt into the unsaved edits at head
  app.post("/api/prompts/:providerId/:id/open-on-head", async c => {
    const { providerId, id } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    if (!provider.variations) {
      return c.json({ error: "This provider has no variations" }, 405);
    }
    const version = c.req.query("version");
    if (!version) return c.json({ error: "A version is required" }, 400);
    try {
      return c.json(
        await provider.variations.openVersionOnHead(
          decodePromptId(id),
          version,
          (await c.req.json().catch(() => ({}))) as OpenOnHeadOptions,
        ),
      );
    } catch (error: any) {
      return errorResponse(c, error, 400);
    }
  });

  // GET /api/variations?ids=a,b - Describe variations, across providers
  app.get("/api/variations", async c => {
    const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
    const found: Record<string, unknown> = {};
    for (const [providerId, provider] of promptProviders) {
      if (!provider.variations) continue;
      for (const id of ids) {
        if (found[id]) continue;
        const info = await provider.variations.get(id).catch(() => undefined);
        if (info) found[id] = { ...info, providerId };
      }
    }
    return c.json(found);
  });

  // Variation routes: resolve the provider's variations capability, then run
  // the matching method.
  const variationRoute =
    (
      handle: (
        variations: NonNullable<PromptProvider["variations"]>,
        params: Record<string, string>,
        c: Context,
      ) => Promise<Response>,
    ) =>
    async (c: Context) => {
      const params = c.req.param();
      const provider = promptProviders.get(params.providerId);
      if (!provider) return c.json({ error: "Provider not found" }, 404);
      if (!provider.variations) {
        return c.json({ error: "This provider has no variations" }, 405);
      }
      try {
        return await handle(provider.variations, params, c);
      } catch (error: any) {
        return errorResponse(c, error, 400);
      }
    };

  // GET /api/variations/:providerId/:vid - One variation
  app.get(
    "/api/variations/:providerId/:vid",
    variationRoute(async (variations, { vid }, c) => {
      const info = await variations.get(vid);
      return info
        ? c.json(info)
        : c.json({ error: "Variation not found" }, 404);
    }),
  );

  // POST /api/variations/:providerId/:vid/open-on-head - Bring into the head WIP
  app.post(
    "/api/variations/:providerId/:vid/open-on-head",
    variationRoute(async (variations, { vid }, c) =>
      c.json(
        await variations.openOnHead(
          vid,
          (await c.req.json().catch(() => ({}))) as OpenOnHeadOptions,
        ),
      ),
    ),
  );

  // POST /api/variations/:providerId/:vid/save - Write a WIP into the source
  app.post(
    "/api/variations/:providerId/:vid/save",
    variationRoute(async (variations, { vid }, c) =>
      c.json(await variations.save(vid)),
    ),
  );

  // POST /api/variations/:providerId/:vid/discard - Drop a WIP
  app.post(
    "/api/variations/:providerId/:vid/discard",
    variationRoute(async (variations, { vid }, c) => {
      await variations.discard(vid);
      return c.body(null, 204);
    }),
  );

  // POST /api/variations/:providerId/:vid/rebase - Re-express against `onto` (default: head)
  app.post(
    "/api/variations/:providerId/:vid/rebase",
    variationRoute(async (variations, { vid }, c) => {
      const { onto } = (await c.req.json().catch(() => ({}))) as {
        onto?: string;
      };
      return c.json(await variations.rebase(vid, onto));
    }),
  );

  // POST /api/variations/:providerId/:vid/resolve - Settle a WIP's conflicts
  app.post(
    "/api/variations/:providerId/:vid/resolve",
    variationRoute(async (variations, { vid }, c) => {
      const { choices } = (await c.req.json().catch(() => ({}))) as {
        choices?: Record<string, "target" | "variation">;
      };
      return c.json(await variations.resolve(vid, choices ?? {}));
    }),
  );

  // PUT /api/variations/:providerId/:vid/name - Name a variation
  app.put(
    "/api/variations/:providerId/:vid/name",
    variationRoute(async (variations, { vid }, c) => {
      const { name } = (await c.req.json().catch(() => ({}))) as {
        name?: string;
      };
      if (typeof name !== "string" || !name.trim()) {
        return c.json({ error: "A name is required" }, 400);
      }
      return c.json(await variations.name(vid, name));
    }),
  );

  // DELETE /api/variations/:providerId/:vid/name/:name - Remove a name
  app.delete(
    "/api/variations/:providerId/:vid/name/:name",
    variationRoute(async (variations, { vid, name }, c) => {
      const info = await variations.get(vid);
      if (!info) return c.json({ error: "Variation not found" }, 404);
      await variations.unname(info.promptId, name);
      return c.body(null, 204);
    }),
  );

  // POST /api/prompts/:providerId/:id/rename - Rename a prompt
  app.post("/api/prompts/:providerId/:id/rename", async c => {
    try {
      const { providerId, id } = c.req.param();
      const { newName } = await c.req.json();
      const provider = promptProviders.get(providerId);
      if (!provider) return c.json({ error: "Provider not found" }, 404);
      if (!provider.renamePrompt)
        return c.json(
          { error: "This provider does not support renaming" },
          405,
        );
      const decodedId = decodePromptId(id);
      const updatedPrompt = await provider.renamePrompt(decodedId, newName);
      return c.json({ ...updatedPrompt, providerId });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  // POST /api/prompts/:providerId/:id/update - Update prompt properties
  app.post("/api/prompts/:providerId/:id/update", async c => {
    try {
      const { providerId, id } = c.req.param();
      const provider = promptProviders.get(providerId);
      if (!provider) {
        return c.json({ error: "Provider not found" }, 404);
      }

      if (!provider.updatePromptProperties) {
        return c.json({ error: "This provider does not support editing" }, 405);
      }

      const decodedId = decodePromptId(id);
      const { prompt, ref } = await provider.updatePromptProperties(
        promptRefFrom(c, decodedId),
        await c.req.json(),
      );
      return c.json({
        prompt: { ...prompt, providerId },
        ref,
      } satisfies UpdatePromptResponse);
    } catch (error: any) {
      return errorResponse(c, error, 400);
    }
  });

  // POST /api/prompts/:providerId/:id/execute - Execute prompt
  //
  // Returns immediately with a trace reference. The actual execution runs in
  // the background; clients subscribe to
  // `/api/traces/:providerId/:traceId/events` for span-level updates.
  app.post("/api/prompts/:providerId/:id/execute", async c => {
    try {
      // Hosts that can't run prompts (e.g. the in-browser demo) disable
      // execution and surface a message the client renders as an error.
      if (executeDisabledMessage) {
        return c.json({ error: executeDisabledMessage }, 400);
      }
      const { providerId, id } = c.req.param();
      const provider = promptProviders.get(providerId);
      if (!provider) {
        return c.json({ error: "Provider not found" }, 404);
      }

      const decodedId = decodePromptId(id);
      const ref = promptRefFrom(c, decodedId);
      const { functionInputs = [], executeInputs = {} } = (await c.req
        .json()
        .catch(() => ({}))) as ExecuteRequest;

      const prompt = await provider.getPrompt(ref);
      if (!prompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      // Inputs arrive unresolved, so resolution happens here — server-side,
      // where a resource can actually be created and where a value's import
      // bindings can actually be imported. A provider that offers non-value
      // sources interprets its own `uri` grammar through `resolveInputs`;
      // every other provider gets the value-only fallback and never has to
      // know an `ExecutionInput` exists.
      const inputs = { functionInputs, executeInputs };
      let resolved: ResolvedPromptInputs;
      try {
        resolved = provider.resolveInputs
          ? await provider.resolveInputs(ref, inputs)
          : { ...(await resolveExecutionInputs(inputs)), release: undefined };
      } catch (err: any) {
        // The request named something that cannot be turned into a value — a
        // dataset cell, a resource that no longer exists. That is a bad
        // request, not a failed run: nothing has been dispatched and no trace
        // exists to carry the error, so it has to be answered here — and
        // logged, since the response carries only the message.
        console.error("failed to resolve prompt inputs:", err);
        return c.json({ error: err?.message ?? String(err) }, 400);
      }
      const { functionParams, executeValues } = resolved;
      // What actually gets recorded on the trace: the request as sent, with
      // each resource reference's receipt filled in from what this run's
      // resolution produced — see `specs/resource-arguments.md` §K. A receipt
      // arriving on a replay request already survived resolution above
      // (`resolveInputs` passes it to `create`); this is what makes the *new*
      // run's own receipt the one a later replay of *this* trace would see.
      const recordedInputs = stampReceipts(inputs, resolved.receipts);

      const response = await tracer.startActiveSpan(prompt.name, async span => {
        const ctx = span.spanContext();
        // On the native (v7) path no OTel tracer provider is registered, so the
        // no-op tracer hands back the all-zero *invalid* span context — the same
        // value for every call. Mint our own unique id then, and name the root
        // span the way the native ingestor does (`${traceId}:root`) so the
        // client's initial span selection resolves. On the OTel/v6 path the span
        // context is real and must be reused: the OTel ingestor records its
        // spans under that same trace id.
        const native = !isSpanContextValid(ctx);
        const traceId = native ? crypto.randomUUID() : ctx.traceId;
        const rootSpanId = native ? `${traceId}:root` : ctx.spanId;

        // The trace is created lazily by the telemetry ingestor when the root
        // span starts. A client that opens the returned trace id before then
        // polls `GET /api/traces/:p/:id` until it appears (see the client's
        // `getTrace`), so no server-side pre-creation is needed.
        let ran: Awaited<ReturnType<PromptProvider["execute"]>>;
        try {
          ran = await provider.execute(ref, functionParams, {
            traceId,
            rootSpanId,
            executeValues,
            inputs: recordedInputs,
            // Run-scoped resources outlive this response: `execute` returns as
            // soon as the run is dispatched, so teardown hangs off completion
            // rather than off the HTTP request.
            onSettled: () => void resolved.release?.(),
          });
        } catch (err: any) {
          void resolved.release?.();
          console.error("prompt execution failed:", err);
          span.recordException(err);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err?.error
              ? JSON.stringify(err.error, null, 2)
              : (err?.message ?? String(err)),
          });
          span.end();
          throw err;
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return {
          traceId,
          rootSpanId,
          tracerProviderId: defaultTraceProviderId,
          ...(ran?.version && { version: ran.version }),
          ...(ran?.variation && { variation: ran.variation }),
        } satisfies ExecuteResponse;
      });

      return c.json(response);
    } catch (error: any) {
      return errorResponse(c, error, 500);
    }
  });

  // GET /api/trace-providers - List trace providers
  app.get("/api/trace-providers", c =>
    c.json(
      Array.from(traceProviders.entries()).map(([id, provider]) => ({
        id,
        displayName: provider.displayName,
        description: provider.description,
      })),
    ),
  );

  // GET /api/traces - List all traces across all trace providers
  app.get("/api/traces", async c => {
    try {
      const results = await Promise.all(
        Array.from(traceProviders.values()).map(p => p.getAllTraces()),
      );
      return c.json(results.flat());
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/traces/:providerId/:id - Fetch a trace together with its spans
  app.get("/api/traces/:providerId/:id", async c => {
    const { providerId, id } = c.req.param();
    const provider = traceProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Trace provider not found" }, 404);
    }
    const trace = await provider.getTrace(id);
    if (!trace) {
      return c.json({ error: "Trace not found" }, 404);
    }
    return c.json({ ...trace, spans: trace.spans.map(resolveSpanPrompt) });
  });

  // DELETE /api/traces/:providerId/:id - Delete a trace with its spans and annotations
  app.delete("/api/traces/:providerId/:id", async c => {
    const { providerId, id } = c.req.param();
    const provider = traceProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Trace provider not found" }, 404);
    }
    if (!provider.deleteTrace) {
      return c.json(
        { error: "This trace provider does not support deleting traces" },
        405,
      );
    }
    try {
      const deleted = await provider.deleteTrace(id);
      return deleted
        ? c.body(null, 204)
        : c.json({ error: "Trace not found" }, 404);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  // GET /api/traces/:providerId/:id/events - SSE stream of trace updates
  // (span lifecycle + annotations — see `./handlers/trace-stream.ts`)
  app.get("/api/traces/:providerId/:id/events", c => {
    const { providerId, id } = c.req.param();
    const provider = traceProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Trace provider not found" }, 404);
    }

    return streamSSE(c, stream =>
      streamTrace(stream, { provider, traceId: id, resolveSpanPrompt }),
    );
  });

  // Annotation routes: resolve the provider, then relay the neutral handler's
  // `{status, body}` — a 204 carries no body of its own.
  const annotationRoute =
    (
      handle: (
        provider: TraceProvider,
        params: Record<string, string>,
        c: Context,
      ) => Promise<AnnotationHandlerResult>,
    ) =>
    async (c: Context) => {
      const params = c.req.param();
      const provider = traceProviders.get(params.providerId);
      if (!provider) return c.json({ error: "Trace provider not found" }, 404);
      const { status, body } = await handle(provider, params, c);
      return body === undefined
        ? c.body(null, status as ContentfulStatusCode)
        : c.json(body as object, status as ContentfulStatusCode);
    };

  // GET /api/traces/:providerId/:traceId/annotations - List annotations
  app.get(
    "/api/traces/:providerId/:traceId/annotations",
    annotationRoute((provider, { traceId }) =>
      handleListAnnotations(provider, traceId),
    ),
  );

  // POST /api/traces/:providerId/:traceId/annotations - Create an annotation
  app.post(
    "/api/traces/:providerId/:traceId/annotations",
    annotationRoute(async (provider, { traceId }, c) =>
      handleCreateAnnotation(
        provider,
        traceId,
        await c.req.json().catch(() => ({})),
      ),
    ),
  );

  // DELETE /api/traces/:providerId/:traceId/annotations/:id - Delete an annotation
  app.delete(
    "/api/traces/:providerId/:traceId/annotations/:id",
    annotationRoute((provider, { traceId, id }) =>
      handleDeleteAnnotation(provider, traceId, id),
    ),
  );

  // A dataset's stored prompt link (a global or provider-scoped id) resolved
  // to one the client can open, or dropped when it no longer resolves — as
  // `resolveSpanPrompt` does for spans.
  const resolvePromptLink: ResolvePromptLink = prompt => {
    const resolved = promptRegistry.resolve(prompt.id, prompt.providerId);
    return resolved
      ? { id: resolved.promptId, providerId: resolved.providerId }
      : undefined;
  };

  // Dataset routes: resolve the provider, then relay the neutral handler's
  // `{status, body}` — a 204 carries no body of its own.
  const relay = (c: Context, { status, body }: DatasetHandlerResult) =>
    body === undefined
      ? c.body(null, status as ContentfulStatusCode)
      : c.json(body as object, status as ContentfulStatusCode);
  const datasetRoute =
    (
      handle: (
        provider: DatasetProvider,
        params: Record<string, string>,
        c: Context,
      ) => Promise<DatasetHandlerResult>,
    ) =>
    async (c: Context) => {
      const params = c.req.param();
      const provider = datasetProviders.get(params.providerId);
      if (!provider) {
        return c.json({ error: "Dataset provider not found" }, 404);
      }
      return relay(c, await handle(provider, params, c));
    };
  const jsonBody = (c: Context) => c.req.json().catch(() => undefined);

  // Dataset changes ride the hot-reload stream, as `trace-changed` does —
  // there is no second stream.
  for (const [providerId, provider] of datasetProviders) {
    provider.watch?.(event => {
      for (const send of hotReloadSubscribers) {
        send({ type: "dataset-changed", providerId, event });
      }
    });
  }

  // GET /api/dataset-providers - List dataset providers
  app.get("/api/dataset-providers", c =>
    c.json(
      Array.from(datasetProviders.entries()).map(([id, provider]) => ({
        id,
        displayName: provider.displayName,
        description: provider.description,
      })),
    ),
  );

  // GET /api/datasets - List datasets across every provider
  app.get("/api/datasets", async c =>
    relay(
      c,
      await handleListDatasets(datasetProviders.values(), resolvePromptLink),
    ),
  );

  // POST /api/datasets/:providerId - Create a dataset
  app.post(
    "/api/datasets/:providerId",
    datasetRoute(async (provider, _params, c) =>
      handleCreateDataset(provider, await jsonBody(c), resolvePromptLink),
    ),
  );

  // GET /api/datasets/:providerId/:id - A dataset with an overview of its rows
  app.get(
    "/api/datasets/:providerId/:id",
    datasetRoute((provider, { id }) =>
      handleGetDataset(provider, id, resolvePromptLink),
    ),
  );

  // GET /api/datasets/:providerId/:id/rows?offset=&limit= - A page of rows
  app.get(
    "/api/datasets/:providerId/:id/rows",
    datasetRoute((provider, { id }, c) =>
      handleListRows(provider, id, {
        offset: c.req.query("offset"),
        limit: c.req.query("limit"),
      }),
    ),
  );

  // PATCH /api/datasets/:providerId/:id - Rename a dataset
  app.patch(
    "/api/datasets/:providerId/:id",
    datasetRoute(async (provider, { id }, c) =>
      handleRenameDataset(provider, id, await jsonBody(c), resolvePromptLink),
    ),
  );

  // DELETE /api/datasets/:providerId/:id - Delete a dataset
  app.delete(
    "/api/datasets/:providerId/:id",
    datasetRoute((provider, { id }) => handleDeleteDataset(provider, id)),
  );

  // POST /api/datasets/:providerId/:id/rows - Add rows
  app.post(
    "/api/datasets/:providerId/:id/rows",
    datasetRoute(async (provider, { id }, c) =>
      handleAddRows(provider, id, await jsonBody(c)),
    ),
  );

  // PATCH /api/datasets/:providerId/:id/rows - Set or clear cells on rows
  app.patch(
    "/api/datasets/:providerId/:id/rows",
    datasetRoute(async (provider, { id }, c) =>
      handleUpdateRows(provider, id, await jsonBody(c)),
    ),
  );

  // DELETE /api/datasets/:providerId/:id/rows/:rowId - Delete a row
  app.delete(
    "/api/datasets/:providerId/:id/rows/:rowId",
    datasetRoute((provider, { id, rowId }) =>
      handleDeleteRow(provider, id, rowId),
    ),
  );

  // POST /v1/traces, POST /otel/v1/traces - OTLP trace export (protobuf or JSON)
  //
  // `x-evalution-provider` lets a sender name which configured trace provider
  // an export should land on when more than one is wired up; the OSS
  // `resolveIngestor` here ignores it and always returns the process's single
  // ingestor (Phase 0 — see `specs/trace-workshopping.md` §A.8). A cloud host
  // supplies its own `otlpIngestor`/`resolveIngestor` keyed off request auth
  // instead.
  const otlpRoute = async (c: Context) => {
    const result = await handleOtlpTraces(
      {
        contentType: c.req.header("content-type") ?? "",
        body: await c.req.arrayBuffer(),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      },
      { resolveIngestor: () => otlpIngestor },
    );
    return c.json(result.body as object, result.status as ContentfulStatusCode);
  };
  app.post("/v1/traces", otlpRoute);
  app.post("/otel/v1/traces", otlpRoute);

  // GET /api/events - Server-Sent Events for hot reload
  app.get("/api/events", c =>
    streamSSE(c, async stream => {
      await stream.writeSSE({ data: JSON.stringify({ type: "connected" }) });

      const send = (data: SSEData) => {
        void stream.writeSSE({ data: JSON.stringify(data) });
      };
      hotReloadSubscribers.add(send);

      await new Promise<void>(resolve => {
        stream.onAbort(() => {
          hotReloadSubscribers.delete(send);
          resolve();
        });
      });
    }),
  );
}
