import { Hono } from 'hono';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer } from 'ws';
import { context, trace, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { PromptProvider } from '../prompt/prompt-provider.ts';
import type { TraceProvider } from '../trace/trace-provider.ts';
import { PromptRegistry } from '../prompt/prompt-registry.ts';
import { setupRoutes } from './api-routes.ts';
import { registerTerminalRoute } from './terminal.ts';
import { fileURLToPath } from 'url';
import type { SSEData } from '../shared/types.ts';
import { MemoryTraceProvider } from '../trace/memory-trace-provider.ts';

export interface ServerOptions {
  promptProviders: PromptProvider[];
  traceProviders: TraceProvider[];
  port: number;
  rootPath: string;
  /** Whether the server was started with a project config file loaded. */
  hasConfig: boolean;
}

/** A running server, returned by {@link startServer}. */
export interface ServerHandle {
  /** The URL the server is listening on, e.g. `http://localhost:3000`. */
  url: string;
  /**
   * Stops the server, force-closing any open connections (including live SSE
   * streams) so it shuts down promptly instead of waiting on them. Used by the
   * CLI to restart cleanly once a config file appears.
   */
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { promptProviders, traceProviders, port, rootPath, hasConfig } = options;

  const promptProviderMap = new Map(promptProviders.map(p => [p.id, p]));
  const traceProviderMap = new Map(traceProviders.map(p => [p.id, p]));

  // Maps globally-unique / provider-scoped prompt IDs carried by trace spans
  // back to a concrete prompt, so runtime traces can link to their prompt.
  const promptRegistry = new PromptRegistry();
  await promptRegistry.rebuild(promptProviderMap);

  // Wire every trace provider that exposes a SpanProcessor into a shared
  // OpenTelemetry tracer so prompt executions can produce real spans.
  const spanProcessors = traceProviders
    .filter(p => !!p.getSpanProcessor)
    .map(p => p.getSpanProcessor!());
  const tracerProvider = new BasicTracerProvider({ spanProcessors });
  trace.setGlobalTracerProvider(tracerProvider);

  // Register an async context manager so the active span set by
  // `startActiveSpan` propagates across `await` boundaries. Without this,
  // `context.active()` always returns ROOT_CONTEXT and spans emitted by the
  // AI SDK's `experimental_telemetry` become detached root spans in their own
  // traces instead of children of the prompt-execution span.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const tracer: Tracer = tracerProvider.getTracer('evalution');

  // For the UI to render new traces, prefer pulling them from
  // a memory provider if we're using one, otherwise just use the first.
  const defaultTraceProviderId = traceProviders.find(p => p instanceof MemoryTraceProvider)?.id ?? traceProviders[0]?.id;
  if (!defaultTraceProviderId) {
    throw new Error('At least one trace provider must be configured');
  }

  const app = new Hono();

  // Hot-reload SSE subscribers. Each `/api/events` connection registers a
  // writer here; `broadcast` fans an event out to all of them.
  const hotReloadSubscribers = new Set<(data: SSEData) => void>();
  const broadcast = (data: SSEData) => {
    for (const send of hotReloadSubscribers) send(data);
  };

  // Setup API routes
  setupRoutes({
    app,
    promptProviders: promptProviderMap,
    traceProviders: traceProviderMap,
    promptRegistry,
    hotReloadSubscribers,
    rootPath,
    hasConfig,
    tracer,
    defaultTraceProviderId,
  });

  // Interactive terminal for onboarding `run_command`/`install_package` steps.
  // Registered before the static catch-all so the upgrade request is routed.
  registerTerminalRoute(app, upgradeWebSocket, rootPath);

  // Serve the built client. `serveStatic`'s root is resolved against
  // `process.cwd()`, which the CLI changes to the user's project, so anchor it
  // to this module instead. Registered as a catch-all after the API routes.
  const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));
  app.get('*', serveStatic({ root: clientRoot }));

  // Setup file watching for all providers that support it
  for (const [providerId, provider] of promptProviderMap) {
    if (provider.watch) {
      provider.watch(async (event) => {
        // Keep the registry in sync so renames/moves resolve to the latest prompt.
        await promptRegistry.rebuild(promptProviderMap);
        broadcast({ type: 'prompt-changed', providerId, event });
      });
    }
  }

  // Forward trace change events to SSE clients
  for (const [providerId, provider] of traceProviderMap) {
    if (provider.watch) {
      provider.watch((event) => {
        broadcast({ type: 'trace-changed', providerId, event });
      });
    }
  }

  // Start server. `noServer: true` lets @hono/node-server own the HTTP upgrade
  // handshake and hand matching requests to the WebSocket routes above.
  const wss = new WebSocketServer({ noServer: true });
  const url = `http://localhost:${port}`;

  // When running from a bundled build the client is served by this process;
  // when running from source (`npm run dev`) the client lives on a separate
  // Vite dev server. Key off the module path rather than `NODE_ENV`, which
  // isn't set under `npx evalution`.
  const isDevServer = import.meta.url.includes('/src/');

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: '0.0.0.0', websocket: { server: wss } }, () => {
      if (isDevServer) {
        console.log(`\n✨ Evalution API server running on ${url}`);
        console.log(`   Frontend dev server: http://localhost:5173\n`);
      } else {
        console.log(`\n✨ Evalution is running at ${url}\n`);
      }
      resolve(s);
    });
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // Drop open connections (notably long-lived SSE streams) up front, or
      // `close` would wait on them forever. (`closeAllConnections` exists on
      // the Node HTTP server but isn't in the union's Http2 arm.)
      if ('closeAllConnections' in server) {
        server.closeAllConnections();
      }
      server.close(err => err ? reject(err) : resolve());
    });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down gracefully...');
    await close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { url, close };
}
