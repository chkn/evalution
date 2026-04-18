import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PromptProvider } from '../prompt/prompt-provider.ts';
import type { TraceProvider } from '../trace/trace-provider.ts';
import type { ExecuteRequest, ExecuteResponse, TraceStreamEvent } from '../shared/types.ts';

export function setupRoutes(
  fastify: FastifyInstance,
  providers: Map<string, PromptProvider>,
  traceProviders: Map<string, TraceProvider>,
  sseClients: Set<FastifyReply>,
  rootPath: string
) {
  const defaultTraceProvider = (): TraceProvider | undefined =>
    traceProviders.values().next().value;
  // GET /api/config - Get server configuration
  fastify.get('/api/config', async () => {
    return { rootPath };
  });

  // GET /api/providers - List providers with display info
  fastify.get('/api/providers', async () => {
    return Array.from(providers.entries()).map(([id, provider]) => ({
      id,
      displayName: provider.displayName,
      description: provider.description,
      icon: provider.icon,
      hasAddPrompt: !!provider.addPrompt,
    }));
  });

  // POST /api/providers/:providerId/add-prompt - Create a new prompt
  fastify.post<{ Params: { providerId: string }; Body: Record<string, any> }>(
    '/api/providers/:providerId/add-prompt',
    async (request, reply) => {
      try {
        const { providerId } = request.params;
        const provider = providers.get(providerId);
        if (!provider) {
          return reply.code(404).send({ error: 'Provider not found' });
        }
        if (!provider.addPrompt) {
          return reply.code(405).send({ error: 'This provider does not support adding prompts' });
        }
        const result = await provider.addPrompt(request.body);
        // Distinguish created prompt (has `id`) from context (has `fields`)
        if ('fields' in result) {
          return result;
        }
        return { ...result, providerId };
      } catch (error: any) {
        reply.code(400).send({ error: error.message });
      }
    }
  );

  // GET /api/providers/:providerId/models
  fastify.get<{ Params: { providerId: string } }>(
    '/api/providers/:providerId/models',
    async (request, reply) => {
      const { providerId } = request.params;
      const provider = providers.get(providerId);
      if (!provider) {
        return reply.code(404).send({ error: 'Provider not found' });
      }
      return (await provider.getModelCatalog?.()) ?? { providers: {} };
    }
  );

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

  // POST /api/prompts/:providerId/:id/rename - Rename a prompt
  fastify.post<{ Params: { providerId: string; id: string }; Body: { newName: string } }>(
    '/api/prompts/:providerId/:id/rename',
    async (request, reply) => {
      try {
        const { providerId, id } = request.params;
        const { newName } = request.body;
        const provider = providers.get(providerId);
        if (!provider) return reply.code(404).send({ error: 'Provider not found' });
        if (!provider.renamePrompt) return reply.code(405).send({ error: 'This provider does not support renaming' });
        const decodedId = Buffer.from(id, 'base64url').toString('utf8');
        const updatedPrompt = await provider.renamePrompt(decodedId, newName);
        return { ...updatedPrompt, providerId };
      } catch (error: any) {
        reply.code(400).send({ error: error.message });
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
  //
  // Returns immediately with a trace reference. The actual execution runs in
  // the background; clients subscribe to
  // `/api/traces/:providerId/:traceId/events` for span-level updates.
  fastify.post<{ Params: { providerId: string; id: string }; Body: ExecuteRequest }>(
    '/api/prompts/:providerId/:id/execute',
    async (request, reply) => {
      try {
        const { providerId, id } = request.params;
        const provider = providers.get(providerId);
        if (!provider) {
          return reply.code(404).send({ error: 'Provider not found' });
        }

        const tracer = defaultTraceProvider();
        if (!tracer) {
          return reply.code(500).send({ error: 'No trace provider configured' });
        }

        const decodedId = Buffer.from(id, 'base64url').toString('utf8');
        const { functionParams = [] } = request.body;

        const prompt = await provider.getPrompt(decodedId);
        if (!prompt) {
          return reply.code(404).send({ error: 'Prompt not found' });
        }

        const trace = await tracer.beginPromptTrace({
          promptProviderId: providerId,
          promptId: decodedId,
          promptName: prompt.name,
          functionParams,
        });

        // Fire-and-forget the real execution; errors are surfaced on the trace
        // (the trace provider owns that wiring).
        provider.execute(decodedId, functionParams, false).catch((err) => {
          fastify.log.error({ err }, 'prompt execution failed');
        });

        const response: ExecuteResponse = {
          traceId: trace.id,
          tracerProviderId: tracer.id,
        };
        return response;
      } catch (error: any) {
        if (!reply.sent) {
          reply.code(500).send({ error: error.message });
        }
      }
    }
  );

  // GET /api/trace-providers - List trace providers
  fastify.get('/api/trace-providers', async () => {
    return Array.from(traceProviders.entries()).map(([id, provider]) => ({
      id,
      displayName: provider.displayName,
      description: provider.description,
    }));
  });

  // GET /api/traces - List all traces across all trace providers
  fastify.get('/api/traces', async (request, reply) => {
    try {
      const results = await Promise.all(
        Array.from(traceProviders.values()).map((p) => p.getAllTraces())
      );
      return results.flat();
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // GET /api/traces/:providerId/:id - Fetch a trace together with its spans
  fastify.get<{ Params: { providerId: string; id: string } }>(
    '/api/traces/:providerId/:id',
    async (request, reply) => {
      const { providerId, id } = request.params;
      const tracer = traceProviders.get(providerId);
      if (!tracer) {
        return reply.code(404).send({ error: 'Trace provider not found' });
      }
      const trace = await tracer.getTrace(id);
      if (!trace) {
        return reply.code(404).send({ error: 'Trace not found' });
      }
      return trace;
    }
  );

  // GET /api/traces/:providerId/:id/events - SSE stream of trace updates
  fastify.get<{ Params: { providerId: string; id: string } }>(
    '/api/traces/:providerId/:id/events',
    async (request, reply) => {
      const { providerId, id } = request.params;
      const tracer = traceProviders.get(providerId);
      if (!tracer) {
        return reply.code(404).send({ error: 'Trace provider not found' });
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

      // Replay existing state so late subscribers aren't stuck waiting for the
      // next event before they can render anything.
      const existing = await tracer.getTrace(id);
      if (existing) {
        for (const span of existing.spans) {
          const initial: TraceStreamEvent =
            span.endTime === undefined
              ? { type: 'span-start', span }
              : { type: 'span-end', span };
          reply.raw.write(`data: ${JSON.stringify(initial)}\n\n`);
        }
      }

      const unsubscribe = tracer.subscribeTrace(id, (event) => {
        if (reply.raw.destroyed) return;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      request.raw.on('close', () => {
        unsubscribe();
      });
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
