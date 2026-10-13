// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFileProvider } from "../file-provider-memory.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import { MemoryTraceProvider } from "../trace/memory-trace-provider.ts";
import { createApiContext } from "./api-context.ts";
import { setupRoutes } from "./api-routes.ts";
import { hostPageCsp } from "./view-frame.ts";
import { ViewRegistry } from "./view-registry.ts";

const TRACE_VIEW = `
import { traceView } from "evalution/views";
export default traceView({
  label: "Tasks",
  applies: trace => trace.spans.length > 0,
  mount(element, props) {
    element.textContent = String(props.trace.spans.length);
    return { update: p => { element.textContent = String(p.trace.spans.length); } };
  },
});
`;

// An empty real directory: esbuild wants a working directory that exists,
// while every project file is read through the MemoryFileProvider. Nothing
// above it has a node_modules, so React isn't installed.
let rootDir: string;
beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "evalution-views-"));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const at = (rel: string) => path.join(rootDir, rel);

function registry(files: Record<string, string>) {
  const fileProvider = new MemoryFileProvider(
    Object.fromEntries(Object.entries(files).map(([rel, c]) => [at(rel), c])),
  );
  return { fileProvider, views: new ViewRegistry({ fileProvider, rootDir }) };
}

describe("ViewRegistry", () => {
  it("finds one view per file and bundles it against the running runtime", async () => {
    const { views } = registry({
      ".evalution/views/traces/tasks.ts": TRACE_VIEW,
    });
    const list = await views.list();
    expect(list.errors).toEqual([]);
    expect(list.views).toEqual([
      {
        uri: ".evalution/views/traces/tasks.ts",
        surface: "traces",
        moduleVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    const bundle = await views.bundle(".evalution/views/traces/tasks.ts");
    // The entry starts the module's default export on its directory's surface.
    expect(bundle?.code).toContain('"traces"');
    expect(bundle?.code).toContain("evalution.view");
    expect(bundle?.code).not.toMatch(/\bimport\s*[{*"]/);
  });

  it("reports a file outside a surface's directory rather than ignoring it", async () => {
    const { views } = registry({
      ".evalution/views/trace/typo.ts": TRACE_VIEW,
      ".evalution/views/loose.ts": TRACE_VIEW,
    });
    const { views: found, errors } = await views.list();
    expect(found).toEqual([]);
    expect(errors).toEqual([
      {
        uri: ".evalution/views/loose.ts",
        message: expect.stringContaining("Not in a surface's directory"),
      },
      {
        uri: ".evalution/views/trace/typo.ts",
        surface: "trace",
        message: expect.stringContaining('no surface named "trace"'),
      },
    ]);
  });

  it("explains a node: import as server-only code imported by accident", async () => {
    const { views } = registry({
      ".evalution/views/traces/fs.ts": `
        import { readFileSync } from "node:fs";
        import { traceView } from "evalution/views";
        export default traceView({ applies: () => !!readFileSync, mount: () => ({ update() {} }) });
      `,
    });
    const { errors } = await views.list();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Imports "node:fs"');
    expect(errors[0].message).toContain("runs in the browser");
    expect(errors[0].message).toContain(".evalution/views/traces/fs.ts:2:");
  });

  it("explains a bare Node built-in the same way", async () => {
    const { views } = registry({
      ".evalution/views/traces/path.ts": `
        import path from "path";
        export default path;
      `,
    });
    const { errors } = await views.list();
    expect(errors[0].message).toContain('Imports "path"');
  });

  it("says to install React when the adapter is used without it", async () => {
    const { views } = registry({
      ".evalution/views/traces/react.tsx": `
        import { traceView } from "evalution/views";
        import { react } from "evalution/views/react";
        export default traceView({ applies: () => true, mount: react(() => <p>hi</p>) });
      `,
    });
    const { errors } = await views.list();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("React isn't installed");
    expect(errors[0].message).toContain("npm install react react-dom");
  });

  it("keeps a broken file from taking the others with it", async () => {
    const { views } = registry({
      ".evalution/views/traces/good.ts": TRACE_VIEW,
      ".evalution/views/traces/bad.ts": "export default {",
    });
    const list = await views.list();
    expect(list.views.map(v => v.uri)).toEqual([
      ".evalution/views/traces/good.ts",
    ]);
    expect(list.errors.map(e => e.uri)).toEqual([
      ".evalution/views/traces/bad.ts",
    ]);
  });

  it("reads imported project files through the FileProvider, and rebuilds when one changes", async () => {
    const { fileProvider, views } = registry({
      ".evalution/shared/count.ts": "export const label = 'one';",
      ".evalution/views/traces/tasks.ts": `
        import { traceView } from "evalution/views";
        import { label } from "../../shared/count.ts";
        export default traceView({ label, applies: () => true, mount: () => ({ update() {} }) });
      `,
      ".evalution/views/datasets/rows.ts": `
        import { datasetView } from "evalution/views";
        export default datasetView({ applies: () => true, mount: () => ({ update() {} }) });
      `,
    });
    const versions: number[] = [];
    views.watch(v => versions.push(v));
    const before = await views.list();
    const tasks = () =>
      views.bundle(".evalution/views/traces/tasks.ts").then(b => b!);
    expect((await tasks()).code).toContain("one");
    const rows = before.views.find(v => v.surface === "datasets")!;

    await fileProvider.writeFile(
      at(".evalution/shared/count.ts"),
      "export const label = 'two';",
    );
    const after = await views.list();
    expect((await tasks()).code).toContain("two");
    expect(after.version).toBeGreaterThan(before.version);
    expect(versions.at(-1)).toBe(after.version);
    const moduleVersion = (list: typeof after, uri: string) =>
      list.views.find(v => v.uri === uri)?.moduleVersion;
    expect(moduleVersion(after, ".evalution/views/traces/tasks.ts")).not.toBe(
      moduleVersion(before, ".evalution/views/traces/tasks.ts"),
    );
    // The view that doesn't import it is left alone.
    expect(moduleVersion(after, rows.uri)).toBe(rows.moduleVersion);
  });

  it("rebuilds a view that failed on a missing import once that file is added", async () => {
    const { fileProvider, views } = registry({
      ".evalution/views/traces/tasks.ts": `
        import { traceView } from "evalution/views";
        import { label } from "../../shared/label.ts";
        export default traceView({ label, applies: () => true, mount: () => ({ update() {} }) });
      `,
    });
    views.watch(() => {});
    expect((await views.list()).errors.map(e => e.uri)).toEqual([
      ".evalution/views/traces/tasks.ts",
    ]);
    await fileProvider.writeFile(
      at(".evalution/shared/label.ts"),
      "export const label = 'Tasks';",
    );
    const after = await views.list();
    expect(after.errors).toEqual([]);
    expect(after.views.map(v => v.uri)).toEqual([
      ".evalution/views/traces/tasks.ts",
    ]);
  });

  it("picks up a view file added later", async () => {
    const { fileProvider, views } = registry({});
    views.watch(() => {});
    expect((await views.list()).views).toEqual([]);
    await fileProvider.writeFile(
      at(".evalution/views/traces/new.ts"),
      TRACE_VIEW,
    );
    expect((await views.list()).views.map(v => v.uri)).toEqual([
      ".evalution/views/traces/new.ts",
    ]);
  });
});

describe("the view routes", () => {
  function app(views: ViewRegistry) {
    const app = new Hono();
    setupRoutes({
      app,
      hotReloadSubscribers: new Set(),
      hasConfig: true,
      views,
      context: createApiContext({
        promptProviders: new Map(),
        traceProviders: new Map([["m", new MemoryTraceProvider({ id: "m" })]]),
        promptRegistry: new PromptRegistry(),
        rootPath: rootDir,
        tracer: trace.getTracer("test"),
        defaultTraceProviderId: "m",
      }),
    });
    return app;
  }

  it("lists the views", async () => {
    const { views } = registry({
      ".evalution/views/traces/tasks.ts": TRACE_VIEW,
    });
    const res = await app(views).request("http://localhost/api/views");
    const body = (await res.json()) as { views: { uri: string }[] };
    expect(body.views.map(v => v.uri)).toEqual([
      ".evalution/views/traces/tasks.ts",
    ]);
  });

  it("serves a frame sandboxed, off the network, and running only its own script", async () => {
    const { views } = registry({
      ".evalution/views/traces/tasks.ts": TRACE_VIEW,
    });
    const [{ moduleVersion }] = (await views.list()).views;
    const res = await app(views).request(
      `http://localhost/api/views/frame?uri=${encodeURIComponent(".evalution/views/traces/tasks.ts")}&v=${moduleVersion}`,
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const directives = csp.split(/;\s*/);
    expect(directives).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-popups");
    expect(csp).not.toContain("allow-same-origin");
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("form-action 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    const html = await res.text();
    expect(html).toContain(`<script type="module" nonce="${nonce}">`);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("doesn't cache a frame asked for by an old version", async () => {
    const { views } = registry({
      ".evalution/views/traces/tasks.ts": TRACE_VIEW,
    });
    const res = await app(views).request(
      `http://localhost/api/views/frame?uri=${encodeURIComponent(".evalution/views/traces/tasks.ts")}&v=old`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s a view that isn't there or didn't build", async () => {
    const { views } = registry({
      ".evalution/views/traces/bad.ts": "export default {",
    });
    const res = await app(views).request(
      `http://localhost/api/views/frame?uri=${encodeURIComponent(".evalution/views/traces/bad.ts")}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("hostPageCsp", () => {
  it("lets the page frame only the frame route", () => {
    expect(hostPageCsp("localhost:3000")).toBe(
      "frame-src http://localhost:3000/api/views/frame",
    );
  });
});
