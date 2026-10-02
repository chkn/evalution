// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Real filesystem, deliberately — what this class is *for* is its file
 * layout (one file per dataset, sidecars, the self-ignoring directory), and
 * the sync engine is a native SQLite build that needs a real path anyway.
 */

import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  def,
  runDatasetProviderContractTests,
  text,
} from "./dataset-provider-contract.ts";
import { LocalDirectoryDatasetProvider } from "./local-directory-dataset-provider.ts";

const contractDirs: string[] = [];
const contractProviders: LocalDirectoryDatasetProvider[] = [];

runDatasetProviderContractTests(
  "LocalDirectoryDatasetProvider",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "evalution-datasets-contract-"));
    contractDirs.push(root);
    const provider = new LocalDirectoryDatasetProvider({
      dir: join(root, "datasets"),
    });
    contractProviders.push(provider);
    return provider;
  },
  async () => {
    await Promise.all(contractProviders.splice(0).map(p => p.close()));
    await Promise.all(
      contractDirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
    );
  },
);

let root: string;
let provider: LocalDirectoryDatasetProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

async function makeProvider(): Promise<{
  provider: LocalDirectoryDatasetProvider;
  dir: string;
}> {
  root = await mkdtemp(join(tmpdir(), "evalution-datasets-"));
  const dir = join(root, "datasets");
  provider = new LocalDirectoryDatasetProvider({ dir });
  return { provider, dir };
}

describe("LocalDirectoryDatasetProvider — files", () => {
  it("writes nothing to disk before the first create", async () => {
    const { provider, dir } = await makeProvider();
    await provider.listDatasets();
    await provider.getDataset("anything");
    await provider.listRows("anything");
    await provider.deleteRows("anything", ["row"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("creates the directory with a self-ignoring .gitignore", async () => {
    const { provider, dir } = await makeProvider();
    await provider.createDataset({ name: "Tickets", fields: [] });
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("leaves a directory that already existed without a .gitignore", async () => {
    const { provider, dir } = await makeProvider();
    await mkdir(dir, { recursive: true });
    await provider.createDataset({ name: "Tickets", fields: [] });
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("keeps one file per dataset, named by id", async () => {
    const { provider, dir } = await makeProvider();
    await provider.createDataset({ name: "Support tickets", fields: [] });
    await provider.createDataset({ name: "Refunds", fields: [] });
    const dbs = (await readdir(dir)).filter(n => n.endsWith(".db")).sort();
    expect(dbs).toEqual(["refunds.db", "support-tickets.db"]);
  });

  it("shows a hand-copied file on the next list, under its file name", async () => {
    const { provider, dir } = await makeProvider();
    const original = await provider.createDataset({
      name: "Tickets",
      fields: [{ def: def("a") }],
    });
    await provider.addRows(original.id, [{ cells: { "0": text("x") } }]);
    await provider.close();

    // Rows may still sit in the write-ahead log, so a copy takes it too.
    await copyFile(join(dir, "tickets.db"), join(dir, "copied.db"));
    if (existsSync(join(dir, "tickets.db-wal"))) {
      await copyFile(join(dir, "tickets.db-wal"), join(dir, "copied.db-wal"));
    }

    const list = await provider.listDatasets();
    expect(list.map(s => [s.id, s.rowCount]).sort()).toEqual([
      ["copied", 1],
      ["tickets", 1],
    ]);
    // Addressable by its new id, even though the row inside still says "tickets".
    expect((await provider.getDataset("copied"))?.id).toBe("copied");
    await provider.addRows("copied", [{ cells: { "0": text("y") } }]);
    expect(await provider.listRows("copied")).toHaveLength(2);
    expect(await provider.listRows("tickets")).toHaveLength(1);
  });

  it("removes the file and its sidecars on delete", async () => {
    const { provider, dir } = await makeProvider();
    const dataset = await provider.createDataset({
      name: "Gone",
      fields: [{ def: def("a") }],
    });
    await provider.addRows(dataset.id, [{ cells: { "0": text("x") } }]);
    // Whatever sidecars the engine left, plus one planted to be sure.
    await writeFile(join(dir, "gone.db-info"), "");

    await provider.deleteDataset(dataset.id);
    const left = (await readdir(dir)).filter(n => n.startsWith("gone"));
    expect(left).toEqual([]);
  });

  it("lists a corrupt file with an error instead of throwing, and reports it once", async () => {
    const { provider, dir } = await makeProvider();
    await provider.createDataset({ name: "Good", fields: [] });
    await writeFile(join(dir, "broken.db"), "this is not a database");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const list = await provider.listDatasets();
      const broken = list.find(s => s.id === "broken");
      expect(broken?.error).toBeTruthy();
      expect(list.find(s => s.id === "good")?.error).toBeUndefined();

      await provider.listDatasets();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(await provider.getDataset("broken")).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("doesn't open two clients on one file under concurrent first creates", async () => {
    const { provider, dir } = await makeProvider();
    const [a, b] = await Promise.all([
      provider.createDataset({ name: "Same", fields: [{ def: def("a") }] }),
      provider.createDataset({ name: "Same", fields: [{ def: def("a") }] }),
    ]);
    expect(new Set([a.id, b.id])).toEqual(new Set(["same", "same-2"]));
    // Both are usable concurrently — a second client on either file would
    // fail with "database is busy".
    await Promise.all([
      provider.addRows(a.id, [{ cells: { "0": text("a") } }]),
      provider.addRows(b.id, [{ cells: { "0": text("b") } }]),
      provider.listDatasets(),
    ]);
    expect(await provider.listRows(a.id)).toHaveLength(1);
    expect(existsSync(join(dir, "same-2.db"))).toBe(true);
  });

  it("refuses ids that could escape the directory", async () => {
    const { provider } = await makeProvider();
    await provider.createDataset({ name: "Inside", fields: [] });
    expect(await provider.getDataset("../inside")).toBeUndefined();
    await expect(
      provider.addRows("../../etc/passwd", [{ cells: {} }]),
    ).rejects.toThrow(/not found/);
  });

  it("forward-applies the migrations to an empty file", async () => {
    const { provider, dir } = await makeProvider();
    await provider.createDataset({ name: "Fresh", fields: [] });
    await provider.close();
    // Reopening runs the (already applied) migrations again: a no-op.
    const reopened = new LocalDirectoryDatasetProvider({ dir });
    try {
      expect((await reopened.getDataset("fresh"))?.name).toBe("Fresh");
    } finally {
      await reopened.close();
    }
  });
});
