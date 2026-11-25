// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const src = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

/**
 * A project on disk with `files`, and a runner that registers the hooks and
 * runs `body`, printing what it returns as JSON. A child process, because the
 * hooks are process-global and vitest's own module runner would answer the
 * imports before Node's loader ever saw them.
 *
 * `body` gets `local` (a `LocalFileProvider`), `at(name)` (a file's absolute
 * path) and `write(name, content)`.
 */
async function run(
  files: Record<string, string>,
  body: string,
  { hooks = true, preamble = "" } = {},
): Promise<any> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-fresh-"));
  tmpDirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  const runner = path.join(root, "runner.mjs");
  await fs.writeFile(
    runner,
    [
      `import { registerFreshImportHook } from ${JSON.stringify(src("cli/fresh-import-hook.ts"))};`,
      `import { registerVariationLoaderHook } from ${JSON.stringify(src("cli/variation-loader-hook.ts"))};`,
      `import { LocalFileProvider } from ${JSON.stringify(src("file-provider-local.ts"))};`,
      `import fs from "node:fs";`,
      `import path from "node:path";`,
      preamble,
      hooks ? "registerFreshImportHook(); registerVariationLoaderHook();" : "",
      `const root = ${JSON.stringify(root)};`,
      "const at = name => path.join(root, name);",
      "const write = (name, content) => fs.writeFileSync(at(name), content);",
      "const local = new LocalFileProvider();",
      "const result = await (async () => {",
      body,
      "})();",
      "console.log(JSON.stringify(result));",
    ].join("\n"),
  );
  const stdout = execFileSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

const entryAndTools = {
  "tools.ts": "export const toolName: string = 'first';\n",
  "entry.ts": [
    "import { toolName } from './tools.ts';",
    "export const tool = toolName;",
    "",
  ].join("\n"),
};

describe("fresh import hook", () => {
  it("reloads what a fresh import imports, not just the module itself", async () => {
    // The module starts using an export its dependency only just gained: the
    // dependency must be reloaded too, or the import can't even link.
    const result = await run(
      entryAndTools,
      `
      const before = await local.import(at("entry.ts"), { fresh: true });
      write("tools.ts", "export const toolName = 'first'; export const added = 'second';\\n");
      write("entry.ts", "import { toolName, added } from './tools.ts';\\nexport const tool = toolName + '+' + added;\\n");
      const after = await local.import(at("entry.ts"), { fresh: true });
      return [before.tool, after.tool];
      `,
    );
    expect(result).toEqual(["first", "first+second"]);
  });

  it("reloads a module when only its dependency changed", async () => {
    const result = await run(
      entryAndTools,
      `
      const before = await local.import(at("entry.ts"), { fresh: true });
      write("tools.ts", "export const toolName = 'edited';\\n");
      const after = await local.import(at("entry.ts"), { fresh: true });
      return [before.tool, after.tool];
      `,
    );
    expect(result).toEqual(["first", "edited"]);
  });

  it("hands back the same module while nothing it loaded has changed", async () => {
    const result = await run(
      entryAndTools,
      `
      const a = await local.import(at("entry.ts"), { fresh: true });
      const b = await local.import(at("entry.ts"), { fresh: true });
      return a === b;
      `,
    );
    expect(result).toBe(true);
  });

  it("gives modules that import each other one shared instance, however they're imported", async () => {
    // A playground module's `inputs` name another module's resources by
    // reference, so the registry's import of `db.ts` and `checks.ts`'s import
    // of it must be the same evaluation.
    const result = await run(
      {
        "db.ts": "export const db = { name: 'db' };\n",
        "checks.ts":
          "import { db } from './db.ts';\nexport const usesDb = db;\n",
      },
      `
      const db = await local.import(at("db.ts"), { fresh: true });
      const checks = await local.import(at("checks.ts"), { fresh: true });
      const plain = await local.import(at("db.ts"));
      write("checks.ts", "import { db } from './db.ts';\\nexport const usesDb = db; export const v = 2;\\n");
      const db2 = await local.import(at("db.ts"), { fresh: true });
      const checks2 = await local.import(at("checks.ts"), { fresh: true });
      return {
        shared: checks.usesDb === db.db,
        plainShared: plain.db === db.db,
        sharedAfterReload: checks2.usesDb === db2.db,
        reloaded: checks2.v === 2,
      };
      `,
    );
    expect(result).toEqual({
      shared: true,
      plainShared: true,
      sharedAfterReload: true,
      reloaded: true,
    });
  });

  it("keeps one instance of packages, rather than reloading them", async () => {
    const result = await run(
      {
        "node_modules/pkg/package.json": JSON.stringify({
          name: "pkg",
          type: "module",
          exports: "./index.js",
        }),
        "node_modules/pkg/index.js": "export const instance = {};\n",
        "entry.ts":
          "import { instance } from 'pkg';\nexport const pkg = instance;\nexport const v = 1;\n",
      },
      `
      const before = await local.import(at("entry.ts"), { fresh: true });
      write("entry.ts", "import { instance } from 'pkg';\\nexport const pkg = instance;\\nexport const v = 2;\\n");
      const after = await local.import(at("entry.ts"), { fresh: true });
      return { reloaded: after.v === 2, samePackage: before.pkg === after.pkg };
      `,
    );
    expect(result).toEqual({ reloaded: true, samePackage: true });
  });

  it("reports a module that throws instead of handing back the version from before", async () => {
    const result = await run(
      entryAndTools,
      `
      await local.import(at("entry.ts"), { fresh: true });
      write("entry.ts", "throw new Error('broken on purpose');\\n");
      const failed = await local.import(at("entry.ts"), { fresh: true }).then(
        () => "loaded",
        err => err.message,
      );
      // Not latched into stale plain imports: a fix is picked up.
      write("entry.ts", "export const tool = 'fixed';\\n");
      const fixed = await local.import(at("entry.ts"), { fresh: true });
      return { failed, fixed: fixed.tool };
      `,
    );
    expect(result).toEqual({ failed: "broken on purpose", fixed: "fixed" });
  });

  it("runs a variation against its dependencies' current versions", async () => {
    const result = await run(
      entryAndTools,
      `
      await local.import(at("entry.ts"), { fresh: true });
      write("tools.ts", "export const toolName = 'edited';\\n");
      const source = fs.readFileSync(at("entry.ts"), "utf8") + "export const variation = true;\\n";
      const variation = await local.importSource(at("entry.ts"), source);
      return [variation.tool, variation.variation];
      `,
    );
    expect(result).toEqual(["edited", true]);
  });

  it("gives a run resources made from the classes its prompt imports, after an edit to the prompt", async () => {
    // A prompt's tool schema checks `instanceof Provider`, and a resource
    // hands it a subclass. Editing the prompt starts a new generation when it
    // is next imported — after the run's resources are made — so the registry
    // has to make them in that generation too, or they extend the previous
    // evaluation of `Provider` and fail the check.
    const result = await run(
      {
        "base.ts": "export class Provider {}\n",
        ".evalution/playground/provider.ts": [
          `import { resource } from ${JSON.stringify(src("prompt/playground/resource.ts"))};`,
          "import { Provider } from '../../base.ts';",
          "class MockProvider extends Provider {}",
          "export const provider = resource({ create: () => ({ value: new MockProvider() }) });",
          "",
        ].join("\n"),
        "prompt.ts": [
          "import { Provider } from './base.ts';",
          "export const accepts = value => value instanceof Provider;",
          "export const v = 1;",
          "",
        ].join("\n"),
      },
      `
      const reg = new ResourceRegistry({ fileProvider: local, rootDir: root });
      const runPrompt = async () => {
        const lease = reg.lease();
        await lease.declare({ provider: { uri: ".evalution/playground/provider.ts#provider" } });
        const value = await lease.acquire("provider");
        const prompt = await local.import(at("prompt.ts"), { fresh: true });
        await lease.release();
        return prompt.accepts(value);
      };
      const before = await runPrompt();
      write("prompt.ts", fs.readFileSync(at("prompt.ts"), "utf8").replace("v = 1", "v = 2"));
      const after = await runPrompt();
      return { before, after };
      `,
      {
        preamble: `import { ResourceRegistry } from ${JSON.stringify(src("prompt/playground/resource-registry.ts"))};`,
      },
    );
    expect(result).toEqual({ before: true, after: true });
  });

  it("falls back to plain imports, with a warning, when the host rejects the query", async () => {
    // Stands in for a transform pipeline that reads the extension off the
    // whole specifier and chokes on the query.
    const result = await run(
      entryAndTools,
      `
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(" "));
      const loaded = await local.import(at("entry.ts"), { fresh: true });
      return { tool: loaded.tool, warned: warnings.some(w => w.includes("restart")) };
      `,
      {
        preamble: [
          `import module from "node:module";`,
          "module.registerHooks({ load(url, context, next) {",
          "  if (url.includes('?')) throw new Error('unsupported specifier');",
          "  return next(url, context);",
          "} });",
        ].join("\n"),
      },
    );
    expect(result).toEqual({ tool: "first", warned: true });
  });
});
