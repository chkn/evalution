// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { DatasetField } from "../dataset/dataset-types.ts";
import { resultInputs } from "./eval-tools.ts";

const FIELDS: DatasetField[] = [
  {
    id: "0",
    def: {
      name: "title",
      type: { kind: "primitive", syntax: "string", base: "string" },
      optional: false,
    },
  },
  {
    id: "1",
    def: {
      name: "taskId",
      type: { kind: "primitive", syntax: "string", base: "string" },
      optional: false,
    },
  },
];

describe("resultInputs", () => {
  it("shows the row's resources as run beside the cells that name them", () => {
    expect(
      resultInputs(
        {
          rowCells: {
            "0": { kind: "value", value: { kind: "primitive", value: "Hi" } },
            "1": { kind: "instance", name: "task", output: "id" },
          },
          rowResources: {
            task: {
              uri: "x.playground.ts#task",
              args: { title: { kind: "dataset", field: "0" } },
            },
          },
        },
        FIELDS,
      ),
    ).toEqual({
      inputs: {
        title: "Hi",
        taskId: { kind: "instance", name: "task", output: "id" },
      },
      resources: {
        task: {
          uri: "x.playground.ts#task",
          args: { title: expect.anything() },
        },
      },
    });
  });

  it("leaves resources out for a row that declared none", () => {
    expect(resultInputs({ rowCells: {} }, FIELDS)).toEqual({ inputs: {} });
  });
});
