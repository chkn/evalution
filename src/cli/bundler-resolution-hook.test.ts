// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const hookUrl = new URL("./bundler-resolution-hook.ts", import.meta.url).href;

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Builds a project laid out the way a bundler-targeted TS project commonly
 * is: an entry file that imports a sibling directory by bare specifier (no
 * `/index.ts`) and a sibling file by bare specifier (no `.ts`) — both of
 * which resolve under `moduleResolution: "bundler"` but not under Node's own
 * strict ESM resolver. Returns a runner script that imports the entry,
 * optionally with the fallback hook registered.
 */
async function makeFixture(
  withHook: boolean,
): Promise<{ runner: string; cwd: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-bundler-"));
  tmpDirs.push(root);

  const toolsDir = path.join(root, "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await fs.writeFile(
    path.join(toolsDir, "index.ts"),
    "export const fromDir = 'dir';\n",
  );

  await fs.writeFile(
    path.join(root, "helper.ts"),
    "export const fromExtensionless = 'ext';\n",
  );

  const entryPath = path.join(root, "entry.ts");
  await fs.writeFile(
    entryPath,
    "import { fromDir } from './tools';\n" +
      "import { fromExtensionless } from './helper';\n" +
      "export default { fromDir, fromExtensionless };\n",
  );

  const register = withHook
    ? `import { registerBundlerResolutionFallback } from ${JSON.stringify(hookUrl)};\n` +
      `registerBundlerResolutionFallback();\n`
    : "";

  const runner = path.join(root, "runner.mjs");
  await fs.writeFile(
    runner,
    register +
      `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});\n` +
      `console.log(JSON.stringify(mod.default));\n`,
  );

  return { runner, cwd: root };
}

describe("bundler-resolution-hook", () => {
  it("resolves a directory import to its index file and an extensionless import to its file", async () => {
    const { runner, cwd } = await makeFixture(true);
    const out = execFileSync(process.execPath, [runner], {
      cwd,
      encoding: "utf8",
    });
    expect(out.trim()).toBe(
      JSON.stringify({ fromDir: "dir", fromExtensionless: "ext" }),
    );
  });

  it("fails on the directory import without the hook, reproducing the reported error", async () => {
    const { runner, cwd } = await makeFixture(false);
    expect(() =>
      execFileSync(process.execPath, [runner], { cwd, stdio: "pipe" }),
    ).toThrow(/Directory import|ERR_UNSUPPORTED_DIR_IMPORT/);
  });

  it("leaves bare package specifiers to normal resolution", async () => {
    const { runner, cwd } = await makeFixture(true);
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

  it("reports the original error when no candidate resolves either", async () => {
    const { runner, cwd } = await makeFixture(true);
    await fs.appendFile(
      runner,
      `await import(${JSON.stringify(pathToFileURL(path.join(cwd, "nope")).href)});\n`,
    );
    let stderr = "";
    try {
      execFileSync(process.execPath, [runner], { cwd, stdio: "pipe" });
      expect.unreachable("expected the import to fail");
    } catch (err: any) {
      stderr = String(err.stderr);
    }
    expect(stderr).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });
});
