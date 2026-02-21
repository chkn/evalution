import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PromptProvider } from '../providers/prompt-provider.ts';
import { AIExecutor } from './ai-executor.ts';
import type { ExecuteRequest } from '../shared/types.ts';

export function setupRoutes(
  fastify: FastifyInstance,
  provider: PromptProvider,
  sseClients: Set<FastifyReply>,
  rootPath: string
) {
  const executor = new AIExecutor();

  // GET /api/config - Get server configuration
  fastify.get('/api/config', async () => {
    return { rootPath };
  });

  // GET /api/prompts - Get all prompts
  fastify.get('/api/prompts', async (request, reply) => {
    try {
      const prompts = await provider.getAllPrompts();
      return prompts;
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // GET /api/prompts/:id - Get specific prompt
  fastify.get<{ Params: { id: string } }>('/api/prompts/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const decodedId = decodeURIComponent(id);
      const prompt = await provider.getPrompt(decodedId);

      if (!prompt) {
        return reply.code(404).send({ error: 'Prompt not found' });
      }

      return prompt;
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // POST /api/prompts/:id/update - Update prompt properties
  fastify.post<{ Params: { id: string }; Body: Record<string, any> }>(
    '/api/prompts/:id/update',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const decodedId = decodeURIComponent(id);

        if (!provider.updatePromptProperties) {
          return reply.code(405).send({ error: 'This provider does not support editing' });
        }

        const updatedPrompt = await provider.updatePromptProperties(decodedId, request.body);

        return updatedPrompt;
      } catch (error: any) {
        reply.code(400).send({ error: error.message });
      }
    }
  );

  // POST /api/prompts/:id/execute - Execute prompt
  fastify.post<{ Params: { id: string }; Body: ExecuteRequest }>(
    '/api/prompts/:id/execute',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const decodedId = decodeURIComponent(id);
        const { stream = false, functionParams = {} } = request.body;

        const prompt = await provider.getPrompt(decodedId);
        if (!prompt) {
          return reply.code(404).send({ error: 'Prompt not found' });
        }

        // Extract file path and function name from ID
        const [filePath, functionName] = decodedId.split('#');

        if (stream) {
          // Set headers for SSE
          reply.raw.setHeader('Content-Type', 'text/event-stream');
          reply.raw.setHeader('Cache-Control', 'no-cache');
          reply.raw.setHeader('Connection', 'keep-alive');

          const textStream = await executor.executePrompt(
            filePath,
            functionName,
            functionParams,
            true
          );

          // Stream chunks
          for await (const chunk of textStream as AsyncIterable<string>) {
            reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          }

          reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          reply.raw.end();
        } else {
          const result = await executor.executePrompt(
            filePath,
            functionName,
            functionParams,
            false
          );
          return result;
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

    // Add client to set
    sseClients.add(reply);

    // Send initial connection message
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Remove client when connection closes
    request.raw.on('close', () => {
      sseClients.delete(reply);
    });
  });
}
