import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { context, trace, type Tracer } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { PromptProvider } from '../prompt/prompt-provider.ts';
import type { TraceProvider } from '../trace/trace-provider.ts';
import { PromptRegistry } from '../prompt/prompt-registry.ts';
import { setupRoutes } from './api-routes.ts';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SSEData } from '../shared/types.ts';
import { MemoryTraceProvider } from '../trace/memory-trace-provider.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  promptProviders: PromptProvider[];
  traceProviders: TraceProvider[];
  port: number;
  rootPath: string;
}

export async function startServer(options: ServerOptions) {
  const { promptProviders, traceProviders, port, rootPath } = options;

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

  const fastify = Fastify({
    logger: {
      level: 'info',
    },
    maxParamLength: 1024,
  });

  // Track SSE clients
  const sseClients = new Set<FastifyReply>();

  // Setup API routes
  setupRoutes({
    fastify,
    promptProviders: promptProviderMap,
    traceProviders: traceProviderMap,
    promptRegistry,
    sseClients,
    rootPath,
    tracer,
    defaultTraceProviderId,
  });

  // Serve static client files
  const clientPath = path.join(__dirname, '..', 'client');
  fastify.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
  });

  const broadcast = (data: SSEData) => {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((reply) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(message);
      }
    });
  };

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

  // Start server
  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    if (process.env.NODE_ENV === 'production') {
      console.log(`\n✨ Evalution is running at http://localhost:${port}\n`);
    } else {
      console.log(`\n✨ Evalution API server running on http://localhost:${port}`);
      console.log(`   Frontend dev server: http://localhost:5173\n`);
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down gracefully...');
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return fastify;
}
