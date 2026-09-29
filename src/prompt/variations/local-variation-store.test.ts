// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVariationStore } from "./local-variation-store.ts";

const tmpDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-varstore-"));
  tmpDirs.push(dir);
  return dir;
}

describe("LocalVariationStore", () => {
  it("creates nothing until the first write", async () => {
    const dir = await tmp();
    const dbPath = path.join(dir, "variations", "variations.db");
    const store = new LocalVariationStore(dbPath);
    expect(await store.listHeadWips()).toEqual([]);
    expect(await store.getHeadWip("p#p")).toBeUndefined();
    await expect(fs.access(path.join(dir, "variations"))).rejects.toThrow();

    await store.putWip({
      promptId: "p#p",
      base: "v1",
      updates: { style: "chat" },
      onHead: true,
    });
    expect((await store.listHeadWips()).map(w => w.promptId)).toEqual(["p#p"]);
    // The directory ignores everything in it, itself included.
    expect(
      await fs.readFile(path.join(dir, "variations", ".gitignore"), "utf8"),
    ).toBe("*\n");
  });

  it("reads as empty, with one warning, when another process holds the database", async () => {
    const dir = await tmp();
    const dbPath = path.join(dir, "variations.db");
    // Turso locks the file against other processes, not other connections in
    // this one, so the holder has to be a process of its own.
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { LocalVariationStore } = await import(${JSON.stringify(
          new URL("./local-variation-store.ts", import.meta.url).href,
        )});
        const store = new LocalVariationStore(${JSON.stringify(dbPath)});
        await store.putWip({ promptId: "p#p", base: "v1", updates: { style: "chat" }, onHead: true });
        console.log("ready");
        process.stdin.resume();
        process.stdin.on("end", () => process.exit(0));`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", d => String(d).includes("ready") && resolve());
        holder.on("exit", code => reject(new Error(`holder exited ${code}`)));
      });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const second = new LocalVariationStore(dbPath);
      expect(await second.listHeadWips()).toEqual([]);
      expect(await second.getHeadWip("p#p")).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(
        /another evalution process/,
      );
      await expect(
        second.putWip({
          promptId: "p#q",
          base: "v1",
          updates: { style: "chat" },
          onHead: true,
        }),
      ).rejects.toThrow(/another evalution process/);
    } finally {
      holder.stdin.end();
      await new Promise(resolve => holder.on("exit", resolve));
    }
  });
});
