import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { PromptProvider } from '../prompt/prompt-provider.ts';
import type { TraceProvider } from '../trace/trace-provider.ts';
import { setupRoutes } from './api-routes.ts';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SSEData } from '../shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  providers: PromptProvider[];
  traceProviders: TraceProvider[];
  port: number;
  rootPath: string;
}

export async function startServer(options: ServerOptions) {
  const { providers, traceProviders, port, rootPath } = options;

  const providerMap = new Map(providers.map(p => [p.id, p]));
  const traceProviderMap = new Map(traceProviders.map(p => [p.id, p]));

  const fastify = Fastify({
    logger: {
      level: 'info',
    },
    maxParamLength: 1024,
  });

  // Track SSE clients
  const sseClients = new Set<FastifyReply>();

  // Setup API routes
  setupRoutes(fastify, providerMap, traceProviderMap, sseClients, rootPath);

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
  for (const [providerId, provider] of providerMap) {
    if (provider.watch) {
      provider.watch((event) => {
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
