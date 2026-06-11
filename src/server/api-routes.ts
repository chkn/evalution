// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import type { PromptRegistry } from "../prompt/prompt-registry.ts";
import type {
  ExecuteRequest,
  ExecuteResponse,
  Span,
  SSEData,
  TraceStreamEvent,
} from "../shared/types.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import {
  executeSetupStep,
  resolveSetupTasks,
  SetupStepNotFoundError,
} from "./setup-tasks.ts";

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
  app.get("/api/setup-tasks", c => c.json(resolveSetupTasks(rootPath)));

  // POST /api/setup-tasks/:taskId/steps/:stepId/execute - Run one onboarding step
  app.post("/api/setup-tasks/:taskId/steps/:stepId/execute", async c => {
    const { taskId, stepId } = c.req.param();
    try {
      return c.json(await executeSetupStep(rootPath, taskId, stepId));
    } catch (error: any) {
      const status = error instanceof SetupStepNotFoundError ? 404 : 400;
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

      const decodedId = Buffer.from(id, "base64url").toString("utf8");
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
      const decodedId = Buffer.from(id, "base64url").toString("utf8");
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

      const decodedId = Buffer.from(id, "base64url").toString("utf8");
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
      const { providerId, id } = c.req.param();
      const provider = promptProviders.get(providerId);
      if (!provider) {
        return c.json({ error: "Provider not found" }, 404);
      }

      const decodedId = Buffer.from(id, "base64url").toString("utf8");
      const { functionParams = [] } = (await c.req
        .json()
        .catch(() => ({}))) as ExecuteRequest;

      const prompt = await provider.getPrompt(decodedId);
      if (!prompt) {
        return c.json({ error: "Prompt not found" }, 404);
      }

      const response = tracer.startActiveSpan(prompt.name, span => {
        const { traceId } = span.spanContext();

        // Fire-and-forget the real execution; the root span is closed
        // when it settles. Child spans emitted via the active context
        // will be parented correctly.
        provider
          .execute(decodedId, functionParams, false)
          .then(
            () => {
              span.setStatus({ code: SpanStatusCode.OK });
            },
            (err: any) => {
              console.error("prompt execution failed:", err);
              span.recordException(err);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err?.error
                  ? JSON.stringify(err.error, null, 2)
                  : (err?.message ?? String(err)),
              });
            },
          )
          .finally(() => {
            span.end();
          });

        return {
          traceId,
          tracerProviderId: defaultTraceProviderId,
          rootSpanId: span.spanContext().spanId,
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
  app.get("/api/traces/:providerId/:id/events", c => {
    const { providerId, id } = c.req.param();
    const provider = traceProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Trace provider not found" }, 404);
    }

    // Resolve a stream event's span (if any) back to a concrete prompt.
    const resolveEvent = (event: TraceStreamEvent): TraceStreamEvent =>
      "span" in event
        ? { ...event, span: resolveSpanPrompt(event.span) }
        : event;

    return streamSSE(c, async stream => {
      await stream.writeSSE({ data: JSON.stringify({ type: "connected" }) });

      // Replay existing state so late subscribers aren't stuck waiting for the
      // next event before they can render anything.
      const existing = await provider.getTrace(id);
      if (existing) {
        for (const span of existing.spans) {
          const resolved = resolveSpanPrompt(span);
          const initial: TraceStreamEvent =
            resolved.endTime === undefined
              ? { type: "span-start", span: resolved }
              : { type: "span-end", span: resolved };
          await stream.writeSSE({ data: JSON.stringify(initial) });
        }
      }

      const unsubscribe = provider.subscribeTrace(id, event => {
        void stream.writeSSE({ data: JSON.stringify(resolveEvent(event)) });
      });

      await new Promise<void>(resolve => {
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
  });

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
