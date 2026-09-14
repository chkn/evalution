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
import { resolveExecutionInputs } from "../prompt/execution-inputs.ts";
import type {
  PromptProvider,
  ResolvedPromptInputs,
} from "../prompt/prompt-provider.ts";
import type { PromptRegistry } from "../prompt/prompt-registry.ts";
import type { SetupTask } from "../shared/setup-task.ts";
import type {
  ExecuteRequest,
  ExecuteResponse,
  Span,
  SSEData,
} from "../shared/types.ts";
import type { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import {
  type AnnotationHandlerResult,
  handleCreateAnnotation,
  handleDeleteAnnotation,
  handleListAnnotations,
} from "./handlers/annotations.ts";
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
    return {
      ...span,
      prompt: { id: resolved.promptId, providerId: resolved.providerId },
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

  // GET /api/providers/:providerId/models
  app.get("/api/providers/:providerId/models", async c => {
    const { providerId } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }
    return c.json((await provider.getModelCatalog?.()) ?? { providers: {} });
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
      const prompt = await provider.getPrompt(decodedId);
      if (!prompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      return c.json({ ...prompt, providerId });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

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
      const updatedPrompt = await provider.updatePromptProperties(
        decodedId,
        await c.req.json(),
      );
      return c.json({ ...updatedPrompt, providerId });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
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
      const { functionInputs = [], executeInputs = {} } = (await c.req
        .json()
        .catch(() => ({}))) as ExecuteRequest;

      const prompt = await provider.getPrompt(decodedId);
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
          ? await provider.resolveInputs(decodedId, inputs)
          : { ...(await resolveExecutionInputs(inputs)), release: undefined };
      } catch (err: any) {
        // The request named something that cannot be turned into a value — a
        // dataset cell, a resource that no longer exists. That is a bad
        // request, not a failed run: nothing has been dispatched and no trace
        // exists to carry the error, so it has to be answered here.
        return c.json({ error: err?.message ?? String(err) }, 400);
      }
      const { functionParams, executeValues } = resolved;

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
        try {
          await provider.execute(decodedId, functionParams, {
            traceId,
            executeValues,
            inputs,
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
        } satisfies ExecuteResponse;
      });

      return c.json(response);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
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
