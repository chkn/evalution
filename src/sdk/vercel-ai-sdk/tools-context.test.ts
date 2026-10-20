// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolsContextProblems } from "./tools-context.ts";

/** A database client's shape that matters here: it can't be JSON-serialized. */
class Db {
  self = this;
}
const db = z.custom<Db>(v => v instanceof Db);

const tools = {
  get_task: { contextSchema: z.object({ db }) },
  update_task: { contextSchema: z.object({ db, runId: z.string() }) },
  finish: {},
};

describe("toolsContextProblems", () => {
  it("is empty when every tool's context matches its schema", async () => {
    expect(
      await toolsContextProblems(tools, {
        get_task: { db: new Db() },
        update_task: { db: new Db(), runId: "run_1" },
      }),
    ).toEqual([]);
  });

  it("names each mismatch by its path, without serializing the context", async () => {
    expect(
      await toolsContextProblems(tools, {
        get_task: { db: new Db() },
        update_task: { db: new Db() },
      }),
    ).toEqual([
      "toolsContext.update_task.runId: Invalid input: expected string, received undefined",
    ]);
  });

  it("reports a tool whose context is missing altogether", async () => {
    expect(
      await toolsContextProblems(tools, {
        update_task: { db: new Db(), runId: "run_1" },
      }),
    ).toEqual([
      "toolsContext.get_task: Invalid input: expected object, received undefined",
    ]);
  });

  it("checks nothing without tools, or for tools that declare no schema", async () => {
    expect(await toolsContextProblems(undefined, undefined)).toEqual([]);
    expect(await toolsContextProblems({ finish: {} }, undefined)).toEqual([]);
  });
});
