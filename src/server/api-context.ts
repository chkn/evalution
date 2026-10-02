// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Everything the API needs at hand, whichever way it's reached: the REST
 * routes (`./api-routes.ts`) and the MCP server (`../mcp/server.ts`) are both
 * built from one {@link ApiContext}, and both answer through the same
 * handlers in `./handlers/`.
 */

import type { Tracer } from "@opentelemetry/api";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import type { PromptRegistry } from "../prompt/prompt-registry.ts";
import type { Span } from "../shared/types.ts";
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
