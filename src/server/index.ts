import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { PromptProvider } from '../providers/prompt-provider.ts';
import { setupRoutes } from './api-routes.ts';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  provider: PromptProvider;
  port: number;
}

export async function startServer(options: ServerOptions) {
  const { provider, port } = options;

  const fastify = Fastify({
    logger: {
      level: 'info',
    },
  });

  // Track SSE clients
  const sseClients = new Set<FastifyReply>();

  // Setup API routes
  setupRoutes(fastify, provider, sseClients);

  // Serve static client files
  const clientPath = path.join(__dirname, '..', 'client');
  fastify.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
  });

  // Setup file watching if supported
  if (provider.supportsWatching && provider.watch) {
    provider.watch((event) => {
      // Broadcast to all SSE clients
      const message = `data: ${JSON.stringify({ type: 'prompt-changed', event })}\n\n`;
      sseClients.forEach((reply) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(message);
        }
      });
    });
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
