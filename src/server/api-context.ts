// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Everything the API needs at hand, whichever way it's reached: the REST
 * routes (`./api-routes.ts`) and the MCP server (`../mcp/server.ts`) are both
 * built from one {@link ApiContext}, and both answer through the same
 * handlers in `./handlers/`.
 */

import { type Tracer, trace } from "@opentelemetry/api";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import type { PromptChangeEvent, Span } from "../shared/types.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import type {
  LookupFieldSourcePrompt,
  ResolvePromptLink,
} from "./handlers/datasets.ts";

/** What {@link createApiContext} takes. */
export interface ApiContextOptions {
  promptProviders: Map<string, PromptProvider>;
  traceProviders: Map<string, TraceProvider>;
  /** Dataset stores. Omitted by hosts with none. */
  datasetProviders?: Map<string, DatasetProvider>;
  promptRegistry: PromptRegistry;
  /** The project's root directory. */
  rootPath: string;
  tracer: Tracer;
  /** The trace provider new runs are recorded on. */
  defaultTraceProviderId: string;
  /**
   * When set, executing a prompt fails with this message instead of running
   * it. Used by the in-browser demo, where execution happens locally via
   * `npx evalution`.
   */
  executeDisabledMessage?: string;
}

/** The providers and lookups the REST routes and the MCP server share. */
export interface ApiContext extends ApiContextOptions {
  datasetProviders: Map<string, DatasetProvider>;
  /**
   * A span with its prompt reference (which may be a global id) resolved to
   * a provider-scoped prompt a client can open. Done at read time against
   * the current registry, so the stored id stays stable across renames.
   */
  resolveSpanPrompt(span: Span): Span;
  /**
   * A dataset's stored prompt link resolved to one a client can open, or
   * dropped when it no longer resolves — as {@link resolveSpanPrompt} does
   * for spans.
   */
  resolvePromptLink: ResolvePromptLink;
  /** Looks up the prompt a "copy this parameter" field names. */
  lookupFieldSourcePrompt: LookupFieldSourcePrompt;
}

/** Builds the {@link ApiContext} the REST routes and MCP server share. */
export function createApiContext(options: ApiContextOptions): ApiContext {
  const { promptRegistry, promptProviders } = options;
  return {
    ...options,
    datasetProviders: options.datasetProviders ?? new Map(),
    resolveSpanPrompt(span) {
      if (!span.prompt) return span;
      const resolved = promptRegistry.resolve(
        span.prompt.id,
        span.prompt.providerId,
      );
      if (!resolved) return span;
      // Only the reference is rewritten: the recorded inputs and definitions
      // ride along, since they're what "Open prompt" fills the panel from.
      return {
        ...span,
        prompt: {
          ...span.prompt,
          id: resolved.promptId,
          providerId: resolved.providerId,
        },
      };
    },
    resolvePromptLink(prompt) {
      const resolved = promptRegistry.resolve(prompt.id, prompt.providerId);
      return resolved
        ? { id: resolved.promptId, providerId: resolved.providerId }
        : undefined;
    },
    lookupFieldSourcePrompt: (providerId, promptId) =>
      promptProviders.get(providerId)?.getPrompt({ promptId }) ??
      Promise.resolve(undefined),
  };
}

/** What {@link createProjectContext} takes. */
export interface ProjectContextOptions {
  promptProviders: PromptProvider[];
  /** At least one; new runs are recorded on the first. */
  traceProviders: TraceProvider[];
  datasetProviders?: DatasetProvider[];
  /** The project's root directory. */
  rootPath: string;
  /** See {@link ApiContextOptions.executeDisabledMessage}. */
  executeDisabledMessage?: string;
  /**
   * Called when a prompt changes, after the prompt registry has caught up
   * with it — e.g. to tell connected browsers.
   */
  onPromptChanged?: (providerId: string, event: PromptChangeEvent) => void;
}

/**
 * The {@link ApiContext} for a project's providers, as every host serves it:
 * the prompt registry built and kept current as prompts change (so links in
 * traces and datasets resolve to wherever a prompt lives now), new runs
 * recorded on the first trace provider, and spans traced with whatever
 * tracer an SDK adapter registered globally (a no-op one if none did).
 */
export async function createProjectContext({
  promptProviders,
  traceProviders,
  datasetProviders = [],
  rootPath,
  executeDisabledMessage,
  onPromptChanged,
}: ProjectContextOptions): Promise<ApiContext> {
  const defaultTraceProvider = traceProviders[0];
  if (!defaultTraceProvider) {
    throw new Error("At least one trace provider must be configured");
  }
  const promptProviderMap = new Map(promptProviders.map(p => [p.id, p]));
  const promptRegistry = new PromptRegistry();
  await promptRegistry.rebuild(promptProviderMap);
  for (const provider of promptProviders) {
    provider.watch?.(async event => {
      await promptRegistry.rebuild(promptProviderMap);
      onPromptChanged?.(provider.id, event);
    });
  }
  return createApiContext({
    promptProviders: promptProviderMap,
    traceProviders: new Map(traceProviders.map(p => [p.id, p])),
    datasetProviders: new Map(datasetProviders.map(p => [p.id, p])),
    promptRegistry,
    rootPath,
    tracer: trace.getTracer("evalution"),
    defaultTraceProviderId: defaultTraceProvider.id,
    ...(executeDisabledMessage !== undefined && { executeDisabledMessage }),
  });
}
