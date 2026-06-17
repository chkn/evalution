// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral factory that builds the evalution Hono app over fully
 * in-memory providers, suitable for running inside a browser service worker.
 *
 * It is intentionally free of any service-worker globals (`self`, `FetchEvent`,
 * …) so it can be unit-tested under Node and bundled for any target. The host
 * (e.g. the marketing site's service worker) wires `self.addEventListener` and
 * forwards `/api/*` requests to {@link MemoryApp.app}'s `fetch`.
 *
 * @module
 */

import type { Tracer } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Hono } from "hono";
import { MemoryFileProvider } from "../file-provider-memory.ts";
import { FilePromptProvider } from "../prompt/file/file-prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import { VercelAISDK } from "../sdk/vercel-ai-sdk.ts";
import type { SSEData } from "../shared/types.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { setupRoutes } from "./api-routes.ts";

/** Default message returned when a client tries to run a prompt in-browser. */
export const RUN_LOCALLY_MESSAGE =
  "Running prompts happens locally. Install evalution and run `npx evalution` " +
  "in your project to execute prompts against real application context.";

/** Options for {@link createMemoryApp}. */
export interface MemoryAppOptions {
  /**
   * Initial files keyed by absolute path — e.g. `/demo/cool.prompt.ts` and
   * `/demo/.evalution/config.ts`. Paths should live under {@link rootDir}.
   */
  files: Record<string, string>;
  /** Project root the prompt provider scans. Defaults to `"/demo"`. */
  rootDir?: string;
  /**
   * Message returned (as a 400) when a client calls the execute endpoint.
   * Defaults to {@link RUN_LOCALLY_MESSAGE}.
   */
  executeDisabledMessage?: string;
}

/** Result of {@link createMemoryApp}. */
export interface MemoryApp {
  /** The configured Hono app; forward `/api/*` requests to `app.fetch`. */
  app: Hono;
  /**
   * The shared in-memory file system. The host can read/write it directly, and
   * every write fans out a `prompt-changed` event over `/api/events`.
   */
  fileProvider: MemoryFileProvider;
}

/**
 * Builds an in-memory evalution app: a {@link FilePromptProvider} backed by a
 * {@link MemoryFileProvider}, a {@link MemoryTraceProvider}, and the full set of
 * {@link setupRoutes} HTTP routes plus a small `/api/files` read/write endpoint.
 *
 * Prompt execution is disabled (returns {@link MemoryAppOptions.executeDisabledMessage});
 * onboarding setup-task routes report no tasks. Both keep the bundle free of any
 * filesystem dependency.
 */
export async function createMemoryApp(
  options: MemoryAppOptions,
): Promise<MemoryApp> {
  const { files, rootDir = "/demo" } = options;
  const executeDisabledMessage =
    options.executeDisabledMessage ?? RUN_LOCALLY_MESSAGE;

  const fileProvider = new MemoryFileProvider(files);
  const promptProvider = new FilePromptProvider({
    fileProvider,
    sdk: new VercelAISDK(),
    rootDir,
  });
  const traceProvider = new MemoryTraceProvider();

  const promptProviders = new Map([[promptProvider.id, promptProvider]]);
  const traceProviders = new Map([[traceProvider.id, traceProvider]]);

  const promptRegistry = new PromptRegistry();
  await promptRegistry.rebuild(promptProviders);

  // setupRoutes requires a Tracer. No real spans are produced (execution is
  // disabled), so we skip the async context manager the Node server installs.
  const spanProcessor = traceProvider.getSpanProcessor();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [spanProcessor],
  });
  const tracer: Tracer = tracerProvider.getTracer("evalution");

  const app = new Hono();

  const hotReloadSubscribers = new Set<(data: SSEData) => void>();
  const broadcast = (data: SSEData) => {
    for (const send of hotReloadSubscribers) send(data);
  };

  setupRoutes({
    app,
    promptProviders,
    traceProviders,
    promptRegistry,
    hotReloadSubscribers,
    rootPath: rootDir,
    hasConfig: true,
    tracer,
    defaultTraceProviderId: traceProvider.id,
    executeDisabledMessage,
    // setupTasks omitted → onboarding routes report no tasks. Combined with
    // hasConfig:true, the client never engages the WelcomeWizard.
  });

  // Raw file read/write for the embedding host (e.g. a live code sample mirror),
  // scoped to the project root. Safe because MemoryFileProvider only ever holds
  // the seeded files.
  const inRoot = (p: string) => p === rootDir || p.startsWith(rootDir + "/");

  app.get("/api/files", async c => {
    const path = c.req.query("path") ?? "";
    if (!inRoot(path)) return c.json({ error: "Path out of scope" }, 400);
    try {
      return c.json({ path, content: await fileProvider.readFile(path) });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });

  app.put("/api/files", async c => {
    const { path, content } = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      content?: string;
    };
    if (!path || !inRoot(path) || typeof content !== "string") {
      return c.json({ error: "Invalid path or content" }, 400);
    }
    await fileProvider.writeFile(path, content);
    return c.json({ path });
  });

  // Fan `prompt-changed` out to all `/api/events` subscribers (the embedded app
  // and the host's code sample) on every prompt change — including this
  // provider's own writes, which are no longer suppressed server-side. Clients
  // dedupe echoes of their own edits (see client/self-edits.ts), so every client
  // sharing this workspace stays in sync.
  promptProvider.watch?.(event => {
    void promptRegistry.rebuild(promptProviders).then(() => {
      broadcast({
        type: "prompt-changed",
        providerId: promptProvider.id,
        event,
      });
    });
  });

  return { app, fileProvider };
}
