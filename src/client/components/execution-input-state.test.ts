// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ExecutionInput } from "../../shared/types";
import {
  fromExecutionInput,
  SELF,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";
import { columnUri, instanceUri } from "./pseudo-sources";

const strVal = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

describe("toExecutionInput", () => {
  it("references an instance, or one of its outputs, chosen for the slot", () => {
    expect(
      toExecutionInput({ resources: { [SELF]: instanceUri("db") } }),
    ).toEqual({ kind: "instance", name: "db" });
    expect(
      toExecutionInput({
        resources: { [SELF]: instanceUri("root", "taskId") },
      }),
    ).toEqual({ kind: "instance", name: "root", output: "taskId" });
  });

  it("grafts an instance into one field of a typed-in object", () => {
    const selection: SlotSelection = {
      value: {
        kind: "object",
        properties: { workspaceId: { kind: "primitive", value: "ws_1" } },
      },
      resources: { db: instanceUri("db") },
    };
    expect(toExecutionInput(selection)).toEqual({
      kind: "object",
      properties: {
        workspaceId: strVal("ws_1"),
        db: { kind: "instance", name: "db" },
      },
    });
  });

  it("leaves out a catalog URI, which only stands for something once adopted", () => {
    expect(
      toExecutionInput({ resources: { [SELF]: "pg.ts#db" } }),
    ).toBeUndefined();
    expect(
      toExecutionInput({
        value: { kind: "primitive", value: "x" },
        resources: { db: "pg.ts#db" },
      }),
    ).toEqual(strVal("x"));
  });
});

describe("fromExecutionInput", () => {
  it("restores instance, column and value inputs as the panel chose them", () => {
    const input: ExecutionInput = {
      kind: "object",
      properties: {
        db: { kind: "instance", name: "db" },
        title: { kind: "dataset", field: "0" },
        workspaceId: strVal("ws_1"),
      },
    };
    const selection = fromExecutionInput(input);
    expect(selection).toEqual({
      value: {
        kind: "object",
        properties: { workspaceId: { kind: "primitive", value: "ws_1" } },
      },
      resources: { db: instanceUri("db"), title: columnUri("0") },
    });
    expect(toExecutionInput(selection)).toEqual({
      kind: "object",
      properties: {
        workspaceId: strVal("ws_1"),
        db: { kind: "instance", name: "db" },
        title: { kind: "dataset", field: "0" },
      },
    });
  });

  it("restores an inline resource stored before instances existed as an empty slot", () => {
    const legacy = {
      kind: "resource",
      uri: "pg.ts#db",
    } as unknown as ExecutionInput;
    expect(fromExecutionInput(legacy)).toEqual({});
  });
});
