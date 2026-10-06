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
 * A project on disk — a prompt that imports a sibling module — and a runner
 * that registers the hook and runs `body`, printing what it returns as JSON.
 * A child process, because the hook is process-global and vitest's own module
 * runner would answer the import before Node's loader ever saw it.
 */
async function run(
  body: string,
  hookUrl: string = src("cli/variation-loader-hook.ts"),
): Promise<any> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-varhook-"));
  tmpDirs.push(root);
  await fs.writeFile(
    path.join(root, "tools.ts"),
    "export const toolName: string = 'real tool';\n",
  );
  await fs.writeFile(
    path.join(root, "odin.prompt.ts"),
    [
      "import { toolName } from './tools.ts';",
      "export const instance = { runs: 0 };",
      "export function odin(name: string) {",
      "  instance.runs++;",
      "  return { system: 'Original', tool: toolName, name };",
      "}",
      "",
    ].join("\n"),
  );
  const runner = path.join(root, "runner.mjs");
  await fs.writeFile(
    runner,
    [
      `import { registerVariationLoaderHook } from ${JSON.stringify(hookUrl)};`,
      `import { LocalFileProvider } from ${JSON.stringify(src("file-provider-local.ts"))};`,
      `import { OverlayFileProvider } from ${JSON.stringify(src("file-provider-overlay.ts"))};`,
      `import { TSPromptFileType } from ${JSON.stringify(src("prompt/file/ts/ts-prompt-file-type.ts"))};`,
      `import fs from "node:fs/promises";`,
      "registerVariationLoaderHook();",
      `const file = ${JSON.stringify(path.join(root, "odin.prompt.ts"))};`,
      "const original = await fs.readFile(file, 'utf8');",
      "const patch = text => original.replace(\"'Original'\", JSON.stringify(text));",
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
  });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("variation loader hook", () => {
  it("runs a variation with the patched system and the sibling's real export", async () => {
    const result = await run(`
      const overlay = new OverlayFileProvider(local);
      overlay.set(file, patch("Patched"));
      const config = await new TSPromptFileType(overlay).loadConfig(file, "odin", ["Ada"]);
      return { config, onDisk: await fs.readFile(file, "utf8") === original };
    `);
    expect(result).toEqual({
      config: { system: "Patched", tool: "real tool", name: "Ada" },
      onDisk: true,
    });
  });

  it("gives two variations of one file separate module instances", async () => {
    const result = await run(`
      const a = await local.importSource(file, patch("A"));
      const b = await local.importSource(file, patch("B"));
      a.odin("x"); a.odin("y"); b.odin("z");
      const again = await local.importSource(file, patch("A"));
      return {
        a: a.odin("-").system, b: b.odin("-").system,
        separate: a.instance !== b.instance,
        runs: [a.instance.runs, b.instance.runs],
        sameSourceSameModule: again === a,
      };
    `);
    expect(result).toEqual({
      a: "A",
      b: "B",
      separate: true,
      runs: [3, 2],
      sameSourceSameModule: true,
    });
  });

  it("runs a variation when the hook was registered by another copy of the module", async () => {
    // The dev server registers the hook from `src/` while the project's
    // config gets its `LocalFileProvider` from `dist/`: two module instances.
    const result = await run(
      `const mod = await local.importSource(file, patch("Other copy"));
      return mod.odin("Ada");`,
      `${src("cli/variation-loader-hook.ts")}?copy=other`,
    );
    expect(result).toEqual({
      system: "Other copy",
      tool: "real tool",
      name: "Ada",
    });
  });

  it("refuses to run a variation without the hook rather than running the file on disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-nohook-"));
    tmpDirs.push(root);
    const runner = path.join(root, "runner.mjs");
    await fs.writeFile(
      runner,
      [
        `import { LocalFileProvider } from ${JSON.stringify(src("file-provider-local.ts"))};`,
        "try {",
        `  await new LocalFileProvider().importSource(${JSON.stringify(path.join(root, "x.ts"))}, "export default 1;");`,
        "  console.log('imported');",
        "} catch (err) { console.log(err.message); }",
      ].join("\n"),
    );
    const stdout = execFileSync(process.execPath, [runner], {
      encoding: "utf8",
    });
    expect(stdout).toMatch(/loader hook/);
  });
});
