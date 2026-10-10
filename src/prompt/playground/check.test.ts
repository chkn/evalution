// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { check, isCheck } from "./check.ts";
import { isResource, resource } from "./resource.ts";
import { ResourceRegistry } from "./resource-registry.ts";

const ROOT = "/proj";
const p = (...segments: string[]) => path.join(ROOT, ...segments);

/** `file:` URLs for the real helpers — see `resource-registry.test.ts`. */
const url = (file: string) =>
  JSON.stringify(pathToFileURL(path.join(import.meta.dirname, file)).href);
const imports = `
  import { resource } from ${url("resource.ts")};
  import { check } from ${url("check.ts")};
  /** A minimal Standard Schema for strings. */
  const str = { "~standard": { version: 1, vendor: "t", validate: v =>
    typeof v === "string" ? { value: v } : { issues: [{ message: "expected a string" }] } } };
`;

function registry(files: Record<string, string>) {
  return new ResourceRegistry({
    fileProvider: new MemoryFileProvider(files),
    rootDir: ROOT,
  });
}

describe("check()", () => {
  it("tags its result, so checks and resources are told apart", () => {
    const c = check({ run: () => true });
    expect(isCheck(c)).toBe(true);
    expect(isResource(c)).toBe(false);
    expect(isCheck(resource({ value: 1 }))).toBe(false);
  });
});

describe("check discovery", () => {
  it("collects checks beside resources, under the same URI grammar", async () => {
    const reg = registry({
      [p(".evalution/playground/checks.ts")]: `${imports}
        export const db = resource({ create: () => ({ value: { rows: [] } }) });
        export const createsTask = check({ label: "Creates a task", run: () => true });
        export const helper = 1;`,
    });
    const checks = await reg.checks();
    expect(checks.map(c => c.uri)).toEqual([
      ".evalution/playground/checks.ts#createsTask",
    ]);
    expect(checks[0].check.label).toBe("Creates a task");
    // The check's module is still a playground module, and its resource is
    // still a resource.
    expect((await reg.all()).map(r => r.key)).toEqual(["db"]);
    expect(await reg.modulePaths()).toEqual([
      p(".evalution/playground/checks.ts"),
    ]);
  });
});

describe("lease.resolveDeclared", () => {
  it("hands a check the run's own instance of a resource, and its validated arguments", async () => {
    const reg = registry({
      [p(".evalution/playground/checks.ts")]: `${imports}
        let created = 0;
        export const db = resource({ create: () => ({ value: { n: ++created } }) });
        export const c = check({ inputs: { db, title: str }, run: () => true });`,
    });
    const [{ check: c }] = await reg.checks();
    const lease = reg.lease();
    await lease.declare({ db: { uri: ".evalution/playground/checks.ts#db" } });
    const runValue = await lease.acquire("db");
    const inputs = await lease.resolveDeclared(c.inputs, "c", async () => ({
      title: "Set up CI",
    }));
    expect(inputs.db).toBe(runValue);
    expect(inputs.title).toBe("Set up CI");
    await lease.release();
  });

  it("names the input and the issue when an argument fails validation", async () => {
    const reg = registry({
      [p(".evalution/playground/checks.ts")]: `${imports}
        export const c = check({ inputs: { title: str }, run: () => true });`,
    });
    const [{ check: c, uri }] = await reg.checks();
    const lease = reg.lease();
    await expect(
      lease.resolveDeclared(c.inputs, uri, async () => ({ title: 7 })),
    ).rejects.toThrow(
      /Check '.*#c': invalid value for 'title' — expected a string/,
    );
    await lease.release();
  });

  it("doesn't resolve arguments for a check that declares none", async () => {
    const reg = registry({});
    const lease = reg.lease();
    let asked = false;
    expect(
      await lease.resolveDeclared(undefined, "c", async () => {
        asked = true;
        return {};
      }),
    ).toEqual({});
    expect(asked).toBe(false);
  });
});
