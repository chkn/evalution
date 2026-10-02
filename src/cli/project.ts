// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Loading a project for the CLI: finding its root, loading its config, and
 * standing up the providers it names (or the defaults). Shared by
 * `evalution ui` and `evalution mcp`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EvalutionConfig } from "../config.ts";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import { LocalDirectoryDatasetProvider } from "../dataset/local-directory-dataset-provider.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import { CostFetchingTraceSink } from "../trace/cost-fetching-trace-sink.ts";
import { LocalDatabaseTraceProvider } from "../trace/local-database-trace-provider.ts";
import { OtlpTraceIngestor } from "../trace/otlp-trace-ingestor.ts";
import type { TraceIngestor } from "../trace/trace-ingestor.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import { isTraceSink } from "../trace/trace-sink.ts";

export async function findRootDir(
  startDir: string,
): Promise<{ rootDir: string; hasConfig: boolean }> {
  let dir = startDir;
  while (true) {
    const configPath = path.join(dir, ".evalution", "config.ts");
    try {
      await fs.access(configPath);
      return { rootDir: dir, hasConfig: true };
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { rootDir: startDir, hasConfig: false };
}

export async function loadConfig(rootDir: string): Promise<EvalutionConfig> {
  const configPath = path.join(rootDir, ".evalution", "config.ts");
  process.chdir(rootDir);
  const mod = await import(pathToFileURL(configPath).href);
  console.log(`⚙️ Loaded config from ${configPath}`);
  return mod.default ?? {};
}

export function applyDotenv(rootDir: string): void {
  const envPath = path.join(rootDir, ".env");
  try {
    process.loadEnvFile(envPath);
    console.log(`📄 Loaded environment variables from ${envPath}`);
  } catch (err: any) {
    // Missing .env is fine; any other error is worth surfacing.
    if (err?.code !== "ENOENT") {
      console.warn(
        `Warning: failed to load .env from ${envPath}:`,
        err.message,
      );
    }
  }
}

/** The providers a project is served with. */
export interface ProjectProviders {
  promptProviders: PromptProvider[];
  traceProviders: TraceProvider[];
  datasetProviders: DatasetProvider[];
  /**
   * The process's single OTLP ingestor, so an external app can export traces
   * to the server (`POST /v1/traces`) alongside whatever the playground
   * records itself.
   */
  otlpIngestor: OtlpTraceIngestor;
}

/**
 * Stands up the providers `config` names — or the defaults, a local trace
 * database and dataset directory under `<rootDir>/.evalution` — and wires
 * every prompt provider's trace ingestion into the trace stores.
 */
export async function setUpProject(
  rootDir: string,
  config: EvalutionConfig,
): Promise<ProjectProviders> {
  if (config.useDotenv !== false) {
    applyDotenv(rootDir);
  }

  const promptProviders = config.promptProviders ?? [];
  let traceProviders = config.traceProviders;

  if (!traceProviders) {
    // An explicit `rootDir`-relative path rather than `LocalDatabaseTraceProvider`'s
    // own CWD-relative default: onboarding mode (no config file yet) never
    // `chdir`s to `rootDir` the way a loaded `config.ts` does, so relying on
    // CWD here could resolve against the wrong directory when the CLI is
    // invoked with an explicit path argument (`evalution ui <path>`).
    const provider = new LocalDatabaseTraceProvider({
      path: path.join(rootDir, ".evalution", "traces", "local.db"),
    });
    traceProviders = [provider];
  }

  // As for traces: `rootDir`-relative, not the provider's CWD-relative default.
  const datasetProviders = config.datasetProviders ?? [
    new LocalDirectoryDatasetProvider({
      dir: path.join(rootDir, ".evalution", "datasets"),
    }),
  ];

  // Each adapter runs its own SDK-specific setup and returns the resulting
  // ingestor — we stand up nothing here beyond the default provider.
  const collected = (
    await Promise.all(promptProviders.map(p => p.setupTraceIngestion?.()))
  ).filter(i => !!i);

  // Drop ingestors a kept one reports redundant (e.g. a 2nd OTelTraceIngestor
  // — OTel is one process-global pipeline).
  const ingestors: TraceIngestor[] = [];
  for (const ing of collected) {
    if (!ingestors.some(kept => kept.isRedundant?.(ing))) ingestors.push(ing);
  }

  // The process's single OTLP ingestor, so an external app can export traces
  // to this server (`POST /v1/traces`) alongside whatever the playground
  // records itself.
  const otlpIngestor = new OtlpTraceIngestor();
  ingestors.push(otlpIngestor);

  // Stamp `llm.cost` on LLM spans before they reach any provider, rather
  // than in each provider, so every trace store gets costed spans for free.
  const costSink = new CostFetchingTraceSink();
  const traceSinks = traceProviders.filter(p => isTraceSink(p));
  for (const sink of traceSinks) {
    costSink.addSink(sink);
  }
  for (const ingestor of ingestors) {
    ingestor.addSink(costSink);
  }

  return {
    promptProviders,
    traceProviders,
    datasetProviders,
    otlpIngestor,
  };
}
