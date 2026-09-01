// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const hookUrl = new URL("./config-loader-hooks.ts", import.meta.url).href;

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Builds a self-contained fixture: a fake `evalution` package in one location
 * and a project config (with no local `node_modules`) that imports it by bare
 * specifier. Returns a runner script that imports the config, optionally with
 * the resolve hook registered.
 */
async function makeFixture(
  withHook: boolean,
): Promise<{ runner: string; cwd: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-resolve-"));
  tmpDirs.push(root);

  // A fake "evalution" package, living where the project can't see it.
  const pkgDir = path.join(root, "cli-install", "node_modules", "evalution");
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "evalution",
      type: "module",
      exports: "./index.js",
    }),
  );
  await fs.writeFile(
    path.join(pkgDir, "index.js"),
    "export class FilePromptProvider {}\n",
  );

  // A project config importing the framework by bare specifier. The project dir
  // deliberately has no node_modules, so this only resolves via the hook.
  const cwd = path.join(root, "project");
  const configPath = path.join(cwd, ".evalution", "config.ts");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    "import { FilePromptProvider } from 'evalution';\n" +
      "export default { ok: typeof FilePromptProvider === 'function' };\n",
  );

  const anchor = pathToFileURL(path.join(pkgDir, "index.js")).href;
  const register = withHook
    ? `import { registerEvalutionResolver } from ${JSON.stringify(hookUrl)};\n` +
      `registerEvalutionResolver(${JSON.stringify(anchor)});\n`
    : "";

  const runner = path.join(root, "runner.mjs");
  await fs.writeFile(
    runner,
    register +
      `const mod = await import(${JSON.stringify(pathToFileURL(configPath).href)});\n` +
      `console.log(JSON.stringify(mod.default));\n`,
  );

  return { runner, cwd };
}

/**
 * Builds a fixture mirroring `npx evalution` pointed at a project: a fake
 * `evalution` package whose lazy `import('ai')` cannot resolve from its own
 * install, and a project that does have `ai` in `node_modules`.
 */
async function makePeerDepFixture(
  withHook: boolean,
): Promise<{ runner: string; cwd: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-peer-"));
  tmpDirs.push(root);

  // The CLI's own install, in a location with no `ai` anywhere above it.
  const cliDir = path.join(root, "npx-install", "node_modules", "evalution");
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(
    path.join(cliDir, "package.json"),
    JSON.stringify({ name: "evalution", type: "module" }),
  );
  await fs.writeFile(
    path.join(cliDir, "bundle.js"),
    "export const load = async () => (await import('ai')).marker;\n",
  );

  // The served project, with `ai` installed the way the user's project has it.
  const cwd = path.join(root, "project");
  const aiDir = path.join(cwd, "node_modules", "ai");
  await fs.mkdir(aiDir, { recursive: true });
  await fs.writeFile(
    path.join(aiDir, "package.json"),
    JSON.stringify({ name: "ai", type: "module", exports: "./index.js" }),
  );
  await fs.writeFile(
    path.join(aiDir, "index.js"),
    "export const marker = 'project-ai';\n",
  );

  const register = withHook
    ? `import { registerPeerDependencyResolver } from ${JSON.stringify(hookUrl)};\n` +
      `registerPeerDependencyResolver(${JSON.stringify(cwd)});\n`
    : "";

  const runner = path.join(root, "runner.mjs");
  await fs.writeFile(
    runner,
    register +
      `const { load } = await import(${JSON.stringify(pathToFileURL(path.join(cliDir, "bundle.js")).href)});\n` +
      `console.log(await load());\n`,
  );

  return { runner, cwd };
}

describe("config-loader-hooks", () => {
  it("resolves a bare `evalution` import from the CLI, not the project dir", async () => {
    const { runner, cwd } = await makeFixture(true);
    const out = execFileSync(process.execPath, [runner], {
      cwd,
      encoding: "utf8",
    });
    expect(out.trim()).toBe('{"ok":true}');
  });

  it("fails without the hook, proving the hook is what makes it resolve", async () => {
    const { runner, cwd } = await makeFixture(false);
    expect(() =>
      execFileSync(process.execPath, [runner], { cwd, stdio: "pipe" }),
    ).toThrow(/Cannot find package 'evalution'/);
  });

  it("resolves `ai` from the served project when the CLI can't see it", async () => {
    const { runner, cwd } = await makePeerDepFixture(true);
    const out = execFileSync(process.execPath, [runner], {
      cwd,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("project-ai");
  });

  it("fails without the peer-dep hook, reproducing the npx crash", async () => {
    const { runner, cwd } = await makePeerDepFixture(false);
    expect(() =>
      execFileSync(process.execPath, [runner], { cwd, stdio: "pipe" }),
    ).toThrow(/Cannot find package 'ai'/);
  });

  it("reports the original error when the project has no copy either", async () => {
    const { runner, cwd } = await makePeerDepFixture(true);
    // Remove the project's `ai`, so neither resolution can succeed.
    await fs.rm(path.join(cwd, "node_modules"), { recursive: true });
    let stderr = "";
    try {
      execFileSync(process.execPath, [runner], { cwd, stdio: "pipe" });
      expect.unreachable("expected the import to fail");
    } catch (err: any) {
      stderr = String(err.stderr);
    }
    expect(stderr).toMatch(/Cannot find package 'ai'/);
    // The reported importer is the real one, not the retry's synthetic anchor.
    expect(stderr).toContain("bundle.js");
    expect(stderr).not.toContain("[evalution-peer-resolver]");
  });

  it("leaves non-peer specifiers to normal resolution", async () => {
    const { runner, cwd } = await makePeerDepFixture(true);
    // `node:path` is not a peer dep; the hook must not touch it.
    await fs.appendFile(
      runner,
      "console.log(typeof (await import('node:path')).join);\n",
    );
    const out = execFileSync(process.execPath, [runner], {
      cwd,
      encoding: "utf8",
    });
    expect(out.trim().split("\n").at(-1)).toBe("function");
  });
});
