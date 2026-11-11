// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { builtinModules } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { CostFetchingTraceSink, handleTraceEvents } from "./ingest.ts";
import { MemoryTraceProvider } from "./trace/memory-trace-provider.ts";
import { TraceEventIngestor } from "./trace/trace-event-ingestor.ts";

const builtins = new Set(builtinModules);
const isNodeBuiltin = (specifier: string) =>
  specifier.startsWith("node:") || builtins.has(specifier.split("/")[0]);

describe("evalution/ingest", () => {
  // What Evalution Cloud's ingest consumer bundles. A Worker has no Node
  // built-ins unless it opts into `nodejs_compat`, so none may be imported
  // statically. Two other kinds are fine: `@evalution/sdk` loads its
  // Node-only portkit discovery with a dynamic import, and only on Node, and
  // protobufjs `require`s `fs` inside a `try`, falling back when it throws.
  it("bundles for Cloudflare Workers without static Node imports", async () => {
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, "ingest.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      // What wrangler resolves with, plus the workspace's source condition.
      conditions: ["workerd", "worker", "browser", "evalution-source"],
      mainFields: ["module", "main"],
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "node-builtins",
          setup(b) {
            b.onResolve({ filter: /.*/ }, args =>
              isNodeBuiltin(args.path)
                ? { path: args.path, external: true }
                : undefined,
            );
          },
        },
      ],
    });

    const staticNodeImports = Object.values(result.metafile.outputs)
      .flatMap(output => output.imports)
      .filter(i => i.external && i.kind === "import-statement")
      .map(i => i.path);
    expect(staticNodeImports).toEqual([]);
  });

  it("costs spans without `process`", async () => {
    vi.stubGlobal("process", undefined);
    try {
      const sink = new CostFetchingTraceSink({ fetch: vi.fn() });
      expect(sink).toBeInstanceOf(CostFetchingTraceSink);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records native trace events through the exported handler", async () => {
    const provider = new MemoryTraceProvider();
    const ingestor = new TraceEventIngestor();
    ingestor.addSink(provider);
    const span = {
      id: "s1",
      traceId: "t1",
      name: "root",
      kind: "DEFAULT",
      startTime: 1,
      endTime: 2,
      status: "ok",
    };
    const result = await handleTraceEvents(
      JSON.stringify({
        events: [
          { type: "span-start", span: { ...span, endTime: undefined } },
          { type: "span-end", span },
        ],
      }),
      ingestor,
    );
    expect(result.status).toBe(200);
    expect((await provider.getTrace("t1"))?.spans).toHaveLength(1);
  });
});
