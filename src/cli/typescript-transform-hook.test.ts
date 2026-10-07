// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { spawnSync } from "node:child_process";
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

/** Written for `tsc`: a parameter property and an enum. */
const ERRORS_TS = [
  "export enum Kind { Taken = 'taken' }",
  "export class NameTakenError extends Error {",
  "  readonly kind: Kind = Kind.Taken;",
  "  constructor(readonly name: string) {",
  "    super(`${name} is taken`);",
  "  }",
  "}",
  "",
].join("\n");

/**
 * A project whose `entry.ts` imports `errors.ts` (see {@link ERRORS_TS}),
 * and a runner that optionally registers the variation loader hook and then
 * this one — in the CLI's order — and runs `body`, printing what it returns
 * (or the error's code) as JSON. A child process, because the hooks are
 * process-global and vitest's own module runner would answer the import
 * before Node's loader ever saw it.
 */
async function run(
  body: string,
  withHook = true,
): Promise<{ result: any; stderr: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-tsxform-"));
  tmpDirs.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await fs.writeFile(path.join(root, "errors.ts"), ERRORS_TS);
  await fs.writeFile(
    path.join(root, "entry.ts"),
    [
      "import { NameTakenError } from './errors.ts';",
      "const error: NameTakenError = new NameTakenError('odin');",
      "export default { name: error.name, kind: error.kind, message: error.message };",
      "",
    ].join("\n"),
  );
  const runner = path.join(root, "runner.mjs");
  await fs.writeFile(
    runner,
    [
      `import { registerVariationLoaderHook } from ${JSON.stringify(src("cli/variation-loader-hook.ts"))};`,
      `import { registerTypeScriptTransformFallback } from ${JSON.stringify(src("cli/typescript-transform-hook.ts"))};`,
      `import { LocalFileProvider } from ${JSON.stringify(src("file-provider-local.ts"))};`,
      withHook
        ? "registerVariationLoaderHook(); registerTypeScriptTransformFallback();"
        : "",
      "try {",
      "  const result = await (async () => {",
      body,
      "  })();",
      "  console.log(JSON.stringify(result));",
      "} catch (err) {",
      "  console.log(JSON.stringify({ error: err.code }));",
      "}",
    ].join("\n"),
  );
  const { stdout, stderr } = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
  });
  return { result: JSON.parse(stdout.trim().split("\n").at(-1)!), stderr };
}

const importEntry = "return (await import('./entry.ts')).default;";

describe("TypeScript transform fallback", () => {
  it("runs modules that use syntax Node's type stripping rejects", async () => {
    const { result, stderr } = await run(importEntry);
    expect(result).toEqual({
      name: "odin",
      kind: "taken",
      message: "odin is taken",
    });
    expect(stderr).not.toMatch(/ExperimentalWarning/);
  });

  it("is what makes them run", async () => {
    expect((await run(importEntry, false)).result).toEqual({
      error: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
    });
  });

  it("runs a variation whose source uses that syntax", async () => {
    const { result } = await run(`
      const mod = await new LocalFileProvider().importSource(
        new URL('./errors.ts', import.meta.url).pathname,
        ${JSON.stringify(ERRORS_TS.replace("is taken", "is in use"))},
      );
      return new mod.NameTakenError('loki').message;
    `);
    expect(result).toBe("loki is in use");
  });
});
