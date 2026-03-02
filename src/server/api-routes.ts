import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PromptProvider } from '../providers/prompt-provider.ts';
import type { ExecuteRequest } from '../shared/types.ts';

export function setupRoutes(
  fastify: FastifyInstance,
  providers: Map<string, PromptProvider>,
  sseClients: Set<FastifyReply>,
  rootPath: string
) {
  // GET /api/config - Get server configuration
  fastify.get('/api/config', async () => {
    return { rootPath };
  });

  // GET /api/providers/:providerId/model-parameters
  fastify.get<{ Params: { providerId: string } }>(
    '/api/providers/:providerId/model-parameters',
    async (request, reply) => {
      const { providerId } = request.params;
      const provider = providers.get(providerId);
      if (!provider) {
        return reply.code(404).send({ error: 'Provider not found' });
      }
      return provider.getModelParameters?.() ?? [];
    }
  );

  // GET /api/prompts - Get all prompts from all providers
  fastify.get('/api/prompts', async (request, reply) => {
    try {
      const results = await Promise.all(
        Array.from(providers.entries()).map(async ([providerId, provider]) => {
          const prompts = await provider.getAllPrompts();
          return prompts.map(prompt => ({ ...prompt, providerId }));
        })
      );
      return results.flat();
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // GET /api/prompts/:providerId/:id - Get specific prompt
  fastify.get<{ Params: { providerId: string; id: string } }>(
    '/api/prompts/:providerId/:id',
    async (request, reply) => {
      try {
        const { providerId, id } = request.params;
        const provider = providers.get(providerId);
        if (!provider) {
          return reply.code(404).send({ error: 'Provider not found' });
        }

        const decodedId = Buffer.from(id, 'base64url').toString('utf8');
        const prompt = await provider.getPrompt(decodedId);
        if (!prompt) {
          return reply.code(404).send({ error: 'Prompt not found' });
        }

        return { ...prompt, providerId };
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  );

  // POST /api/prompts/:providerId/:id/update - Update prompt properties
  fastify.post<{ Params: { providerId: string; id: string }; Body: Record<string, any> }>(
    '/api/prompts/:providerId/:id/update',
    async (request, reply) => {
      try {
        const { providerId, id } = request.params;
        const provider = providers.get(providerId);
        if (!provider) {
          return reply.code(404).send({ error: 'Provider not found' });
        }

        if (!provider.updatePromptProperties) {
          return reply.code(405).send({ error: 'This provider does not support editing' });
        }

        const decodedId = Buffer.from(id, 'base64url').toString('utf8');
        const updatedPrompt = await provider.updatePromptProperties(decodedId, request.body);
        return { ...updatedPrompt, providerId };
      } catch (error: any) {
        reply.code(400).send({ error: error.message });
      }
    }
  );

  // POST /api/prompts/:providerId/:id/execute - Execute prompt
  fastify.post<{ Params: { providerId: string; id: string }; Body: ExecuteRequest }>(
    '/api/prompts/:providerId/:id/execute',
    async (request, reply) => {
      try {
        const { providerId, id } = request.params;
        const provider = providers.get(providerId);
        if (!provider) {
          return reply.code(404).send({ error: 'Provider not found' });
        }

        const decodedId = Buffer.from(id, 'base64url').toString('utf8');
        const { stream = false, functionParams = [] } = request.body;

        if (stream) {
          reply.raw.setHeader('Content-Type', 'text/event-stream');
          reply.raw.setHeader('Cache-Control', 'no-cache');
          reply.raw.setHeader('Connection', 'keep-alive');

          const textStream = await provider.execute(decodedId, functionParams, true);

          for await (const chunk of textStream as AsyncIterable<string>) {
            reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          }

          reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          reply.raw.end();
        } else {
          return await provider.execute(decodedId, functionParams, false);
        }
      } catch (error: any) {
        if (!reply.sent) {
          reply.code(500).send({ error: error.message });
        }
      }
    }
  );

  // GET /api/events - Server-Sent Events for hot reload
  fastify.get('/api/events', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    sseClients.add(reply);
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    request.raw.on('close', () => {
      sseClients.delete(reply);
    });
  });
}
