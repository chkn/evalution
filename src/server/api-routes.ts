// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { EvalProvider } from "../eval/eval-provider.ts";
import type { EvalRunner } from "../eval/eval-runner.ts";
import type {
  OpenOnHeadOptions,
  PromptProvider,
} from "../prompt/prompt-provider.ts";
import { isPromptStyle } from "../shared/helpers.ts";
import type { SetupTask } from "../shared/setup-task.ts";
import type {
  ExecuteRequest,
  PromptRef,
  SSEData,
  UpdatePromptResponse,
} from "../shared/types.ts";
import type { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
import type { ApiContext } from "./api-context.ts";
import {
  handleCreateAnnotation,
  handleDeleteAnnotation,
  handleListAnnotations,
  handleUpdateAnnotation,
} from "./handlers/annotations.ts";
import {
  handleAddField,
  handleAddRows,
  handleCreateDataset,
  handleDeleteDataset,
  handleDeleteField,
  handleDeleteRow,
  handleGetDataset,
  handleListDatasets,
  handleListRows,
  handleQueryRows,
  handleRenameDataset,
  handleRenameField,
  handleUpdateRows,
} from "./handlers/datasets.ts";
import {
  evalRunnerOrRefusal,
  handleCancelRun,
  handleCreateEval,
  handleDeleteEval,
  handleDeleteRun,
  handleGetEval,
  handleGetRun,
  handleListEvals,
  handleListRuns,
  handleStartRun,
  handleTraceCheckResults,
  handleUpdateEval,
} from "./handlers/evals.ts";
import { handleOtlpTraces } from "./handlers/otlp-ingest.ts";
import {
  handleExecutePrompt,
  handleGetPrompt,
  handleListPrompts,
  promptFailure,
} from "./handlers/prompts.ts";
import type { HandlerResult } from "./handlers/result.ts";
import { streamTrace } from "./handlers/trace-stream.ts";
import {
  handleDeleteTrace,
  handleGetTrace,
  handleGetTraceQuerySchema,
  handleListTraces,
  handleQueryTraces,
} from "./handlers/traces.ts";

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
 * `GET /api/config`: the project's root and whether it has a config file —
 * what the playground starts from, and what `findRunningServer` checks a
 * running server against before a later `evalution` process uses it.
 */
export function mountConfigRoute(
  app: Hono,
  rootPath: string,
  configured: boolean,
): void {
  app.get("/api/config", c => c.json({ rootPath, configured }));
}

/** Relays a neutral handler's `{status, body}` — a 204 carries no body of its own. */
function relay(c: Context, { status, body }: HandlerResult) {
  return body === undefined
    ? c.body(null, status as ContentfulStatusCode)
    : c.json(body as object, status as ContentfulStatusCode);
}

/**
 * A route for one of `providers`, named by the `:providerId` param: answers
 * `handle`'s result, or a 404 with `notFound` when there's no such provider.
 */
const providerRoute =
  <P>(providers: Map<string, P>, notFound: string) =>
  (
    handle: (
      provider: P,
      params: Record<string, string>,
      c: Context,
    ) => HandlerResult | Promise<HandlerResult>,
  ) =>
  async (c: Context) => {
    const params = c.req.param();
    const provider = providers.get(params.providerId);
    if (!provider) return c.json({ error: notFound }, 404);
    return relay(c, await handle(provider, params, c));
  };

/**
 * The response for an error from a versions or variations call: a conflict is
 * a 409 carrying the conflicting fields, so the client can show them.
 */
function errorResponse(c: Context, error: any, status: ContentfulStatusCode) {
  return relay(c, promptFailure(error, status));
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
  /** The providers and lookups the routes answer from. */
  context: ApiContext;
  /** Registry of hot-reload SSE writers; each `/api/events` client adds one. */
  hotReloadSubscribers: Set<(data: SSEData) => void>;
  /** Whether the server was started with a project config file loaded. */
  hasConfig: boolean;
  /**
   * Optional onboarding setup-task handlers. When omitted, the setup-task
   * routes report no tasks / 404 (used by hosts without a filesystem).
   */
  setupTasks?: SetupTaskHandlers;
  /**
   * The process's OTLP ingestor, if any. When set, `POST /v1/traces` (and the
   * `/otel/v1/traces` alias) accept incoming OTLP trace exports and feed them
   * to it. Omitted hosts (e.g. the in-browser demo) simply don't expose the
   * route's functionality — `resolveIngestor` always returns `undefined`.
   */
  otlpIngestor?: OtlpTraceIngestor;
}

/**
 * Registers every REST route on `app`, answering through the neutral handlers
 * in `./handlers/` from `context` — which a host can serve over MCP too.
 */
export function setupRoutes({
  app,
  context,
  hotReloadSubscribers,
  hasConfig,
  setupTasks,
  otlpIngestor,
}: SetupRoutesOptions): void {
  const {
    promptProviders,
    traceProviders,
    datasetProviders,
    rootPath,
    resolveSpanPrompt,
    resolvePromptLink,
  } = context;

  mountConfigRoute(app, rootPath, hasConfig);

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
  app.get("/api/prompts", async c =>
    relay(c, await handleListPrompts(promptProviders)),
  );

  // GET /api/prompts/:providerId/:id - Get specific prompt
  app.get("/api/prompts/:providerId/:id", async c => {
    const { providerId, id } = c.req.param();
    const provider = promptProviders.get(providerId);
    if (!provider) {
      return c.json({ error: "Provider not found" }, 404);
    }
    let ref: PromptRef;
    try {
      ref = promptRefFrom(c, decodePromptId(id));
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
    return relay(c, await handleGetPrompt(provider, ref));
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

  // GET /api/prompt-providers/:providerId/head - The commit checked out and whether
  // the tree is clean, for the eval run dialog's warnings (`specs/evals.md`
  // §C). `{ versioned: false }` for a provider without versions.
  app.get("/api/prompt-providers/:providerId/head", async c => {
    const provider = promptProviders.get(c.req.param("providerId"));
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    if (!provider.versions) return c.json({ versioned: false, clean: false });
    try {
      const head = await provider.versions.head();
      return c.json({
        versioned: true,
        clean: head.clean,
        ...(head.commit && { commit: head.commit }),
      });
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
    // Answered before the id is even decoded: a host that can't run prompts
    // says so whatever the request names.
    if (context.executeDisabledMessage) {
      return c.json({ error: context.executeDisabledMessage }, 400);
    }
    const { providerId, id } = c.req.param();
    let ref: PromptRef;
    try {
      ref = promptRefFrom(c, decodePromptId(id));
    } catch (error: any) {
      return errorResponse(c, error, 500);
    }
    const request = (await c.req.json().catch(() => ({}))) as ExecuteRequest;
    return relay(
      c,
      await handleExecutePrompt(
        context,
        promptProviders.get(providerId),
        ref,
        request,
      ),
    );
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
  app.get("/api/traces", async c =>
    relay(c, await handleListTraces(traceProviders.values())),
  );

  // Trace provider routes: resolve the provider, then relay the neutral
  // handler's `{status, body}`.
  const traceRoute = providerRoute(traceProviders, "Trace provider not found");

  // GET /api/trace-providers/:providerId/schema - The tables a query runs against
  app.get(
    "/api/trace-providers/:providerId/schema",
    traceRoute(provider => handleGetTraceQuerySchema(provider)),
  );

  // POST /api/trace-providers/:providerId/query - One read-only SQL query
  app.post(
    "/api/trace-providers/:providerId/query",
    traceRoute(async (provider, _params, c) =>
      handleQueryTraces(provider, await c.req.json().catch(() => undefined)),
    ),
  );

  // GET /api/traces/:providerId/:id - Fetch a trace together with its spans
  app.get(
    "/api/traces/:providerId/:id",
    traceRoute((provider, { id }) =>
      handleGetTrace(provider, id, resolveSpanPrompt),
    ),
  );

  // DELETE /api/traces/:providerId/:id - Delete a trace with its spans and annotations
  app.delete(
    "/api/traces/:providerId/:id",
    traceRoute((provider, { id }) => handleDeleteTrace(provider, id)),
  );

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

  // GET /api/traces/:providerId/:traceId/annotations - List annotations
  app.get(
    "/api/traces/:providerId/:traceId/annotations",
    traceRoute((provider, { traceId }) =>
      handleListAnnotations(provider, traceId),
    ),
  );

  // POST /api/traces/:providerId/:traceId/annotations - Create an annotation
  app.post(
    "/api/traces/:providerId/:traceId/annotations",
    traceRoute(async (provider, { traceId }, c) =>
      handleCreateAnnotation(
        provider,
        traceId,
        await c.req.json().catch(() => ({})),
      ),
    ),
  );

  // PATCH /api/traces/:providerId/:traceId/annotations/:id - Change an annotation's kind or note
  app.patch(
    "/api/traces/:providerId/:traceId/annotations/:id",
    traceRoute(async (provider, { traceId, id }, c) =>
      handleUpdateAnnotation(
        provider,
        traceId,
        id,
        await c.req.json().catch(() => ({})),
      ),
    ),
  );

  // DELETE /api/traces/:providerId/:traceId/annotations/:id - Delete an annotation
  app.delete(
    "/api/traces/:providerId/:traceId/annotations/:id",
    traceRoute((provider, { traceId, id }) =>
      handleDeleteAnnotation(provider, traceId, id),
    ),
  );

  // Dataset routes: resolve the provider, then relay the neutral handler's
  // `{status, body}`.
  const datasetRoute = providerRoute(
    datasetProviders,
    "Dataset provider not found",
  );
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
      handleCreateDataset(
        provider,
        await jsonBody(c),
        resolvePromptLink,
        context.lookupFieldSourcePrompt,
      ),
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

  // POST /api/datasets/:providerId/:id/fields - Add a field, by type or by
  // copying a prompt parameter the server looks up itself
  app.post(
    "/api/datasets/:providerId/:id/fields",
    datasetRoute(async (provider, { id }, c) =>
      handleAddField(
        provider,
        id,
        await jsonBody(c),
        context.lookupFieldSourcePrompt,
        context.lookupFieldSourceCheck,
      ),
    ),
  );

  // PATCH /api/datasets/:providerId/:id/fields/:fieldId - Rename a field
  app.patch(
    "/api/datasets/:providerId/:id/fields/:fieldId",
    datasetRoute(async (provider, { id, fieldId }, c) =>
      handleRenameField(provider, id, fieldId, await jsonBody(c)),
    ),
  );

  // DELETE /api/datasets/:providerId/:id/fields/:fieldId - Delete a field and its cells
  app.delete(
    "/api/datasets/:providerId/:id/fields/:fieldId",
    datasetRoute((provider, { id, fieldId }) =>
      handleDeleteField(provider, id, fieldId),
    ),
  );

  // POST /api/datasets/:providerId/:id/query - One read-only SQL query over the rows
  app.post(
    "/api/datasets/:providerId/:id/query",
    datasetRoute(async (provider, { id }, c) =>
      handleQueryRows(provider, id, await jsonBody(c)),
    ),
  );

  // DELETE /api/datasets/:providerId/:id/rows/:rowId - Delete a row
  app.delete(
    "/api/datasets/:providerId/:id/rows/:rowId",
    datasetRoute((provider, { id, rowId }) =>
      handleDeleteRow(provider, id, rowId),
    ),
  );

  // #region Evals — `specs/evals.md` §F

  const { evalProviders, evalRunner, runsInterrupted, listChecksOf } = context;
  context.onEvalProgress(progress => {
    for (const send of hotReloadSubscribers) {
      send({ type: "eval-run", ...progress });
    }
  });

  // Eval changes ride the hot-reload stream too.
  for (const [providerId, provider] of evalProviders) {
    provider.watch?.(event => {
      for (const send of hotReloadSubscribers) {
        send({ type: "eval-changed", providerId, event });
      }
    });
  }

  const evalRoute = providerRoute(evalProviders, "Eval provider not found");
  const runnerRoute = (
    handle: (
      runner: EvalRunner,
      provider: EvalProvider,
      params: Record<string, string>,
      c: Context,
    ) => HandlerResult | Promise<HandlerResult>,
  ) =>
    evalRoute((provider, params, c) => {
      const found = evalRunnerOrRefusal(
        evalRunner,
        context.executeDisabledMessage,
      );
      return found.ok
        ? handle(found.runner, provider, params, c)
        : found.result;
    });

  // GET /api/eval-providers - List eval providers
  app.get("/api/eval-providers", c =>
    c.json(
      Array.from(evalProviders.values()).map(p => ({
        id: p.id,
        displayName: p.displayName,
      })),
    ),
  );

  // GET /api/evals - List evals across every provider
  app.get("/api/evals", async c =>
    relay(c, await handleListEvals(evalProviders.values())),
  );

  // POST /api/evals/:providerId - Create an eval
  app.post(
    "/api/evals/:providerId",
    evalRoute(async (provider, _params, c) =>
      handleCreateEval(provider, await jsonBody(c)),
    ),
  );

  // GET /api/evals/:providerId/:id - An eval's definition
  app.get(
    "/api/evals/:providerId/:id",
    evalRoute((provider, { id }) => handleGetEval(provider, id)),
  );

  // PATCH /api/evals/:providerId/:id - Change an eval's definition
  app.patch(
    "/api/evals/:providerId/:id",
    evalRoute(async (provider, { id }, c) =>
      handleUpdateEval(provider, id, await jsonBody(c)),
    ),
  );

  // DELETE /api/evals/:providerId/:id - Delete an eval, with its runs
  app.delete(
    "/api/evals/:providerId/:id",
    evalRoute((provider, { id }) => handleDeleteEval(provider, id)),
  );

  // POST /api/evals/:providerId/:id/runs - Start a run: `{ arms?, concurrency? }`
  app.post(
    "/api/evals/:providerId/:id/runs",
    runnerRoute(async (runner, provider, { id }, c) => {
      await runsInterrupted;
      return handleStartRun(runner, provider, id, await jsonBody(c));
    }),
  );

  // GET /api/evals/:providerId/:id/runs - An eval's runs, newest first
  app.get(
    "/api/evals/:providerId/:id/runs",
    evalRoute((provider, { id }) => handleListRuns(provider, id)),
  );

  // GET /api/eval-runs/:providerId/:runId - A run with its results
  app.get(
    "/api/eval-runs/:providerId/:runId",
    evalRoute((provider, { runId }) =>
      handleGetRun(evalRunner, provider, runId),
    ),
  );

  // POST /api/eval-runs/:providerId/:runId/cancel - Cancel a running run
  app.post(
    "/api/eval-runs/:providerId/:runId/cancel",
    runnerRoute((runner, _provider, { runId }) =>
      handleCancelRun(runner, runId),
    ),
  );

  // DELETE /api/eval-runs/:providerId/:runId - Delete a run, with its results
  app.delete(
    "/api/eval-runs/:providerId/:runId",
    evalRoute((provider, { runId }) =>
      handleDeleteRun(evalRunner, provider, runId),
    ),
  );

  // GET /api/checks - Every prompt provider's checks
  app.get("/api/checks", async c => {
    const all = await Promise.all(
      [...promptProviders.keys()].map(async providerId => ({
        providerId,
        checks: (await listChecksOf(providerId)) ?? [],
      })),
    );
    return c.json(all);
  });

  // GET /api/traces/:providerId/:id/check-results - Check results for a trace
  app.get("/api/traces/:providerId/:id/check-results", async c => {
    const { providerId, id } = c.req.param();
    return relay(
      c,
      await handleTraceCheckResults(evalProviders.values(), providerId, id),
    );
  });

  // #endregion

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
