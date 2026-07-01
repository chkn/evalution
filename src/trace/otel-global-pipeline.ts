// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { OTelTraceIngestor } from "./otel-trace-ingestor.ts";

// Process-global: the OTel tracer provider and context manager can only be
// set once per process. Any number of SDK adapters that need OTel (e.g. the
// Vercel AI SDK's v6 support, and any future SDK built on OTel) must share a
// single pipeline instead of each standing one up, so this is memoized here
// rather than per-adapter.
let globalOTelPipeline: Promise<OTelTraceIngestor> | undefined;

/**
 * Stands up the process-global OpenTelemetry tracer provider and
 * `AsyncLocalStorageContextManager`, if not already done, and returns the
 * {@link OTelTraceIngestor} feeding it.
 *
 * Safe to call from multiple SDK adapters: the underlying setup runs at most
 * once per process, and every caller is resolved with the same ingestor
 * instance.
 */
export function setupGlobalOTelPipeline(): Promise<OTelTraceIngestor> {
  globalOTelPipeline ??= doSetup();
  return globalOTelPipeline;
}

async function doSetup(): Promise<OTelTraceIngestor> {
  const { context, trace } = await import("@opentelemetry/api");
  const { AsyncLocalStorageContextManager } = await import(
    "@opentelemetry/context-async-hooks"
  );
  const { BasicTracerProvider } = await import(
    "@opentelemetry/sdk-trace-base"
  );

  const ingestor = new OTelTraceIngestor();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [ingestor.getSpanProcessor()],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  return ingestor;
}
