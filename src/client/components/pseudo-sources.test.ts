// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import { fromExecutionInput, toExecutionInput } from "./execution-input-state";
import {
  checkParameterSources,
  columnUri,
  describePseudoSource,
  inputUri,
  NEW_COLUMN_URI,
  pseudoInput,
  withPseudoSources,
} from "./pseudo-sources";
import { computeClaims } from "./resource-args-context";

const def = (name: string, syntax: string, base = syntax): PropDefinition => ({
  name,
  optional: false,
  type: { kind: "primitive", syntax, base: base as "string" },
});

const functionParameters = [
  def("taskId", "TaskId", "string"),
  def("title", "string"),
  def("count", "number"),
];

/** No slot bound at all. */
const NO_BINDINGS = { functionInputs: {}, executeInputs: {} };

describe("pseudo-source URIs", () => {
  it("round-trip through the panel's selection state", () => {
    for (const input of [
      { kind: "dataset", field: "3" },
      { kind: "input", half: "execute", path: "ctx.db" },
    ] as const) {
      const { selection } = fromExecutionInput(input);
      expect(toExecutionInput(selection)).toEqual(input);
    }
    expect(pseudoInput(columnUri("a"))).toEqual({
      kind: "dataset",
      field: "a",
    });
    expect(pseudoInput(".evalution/playground/db.ts#db")).toBeUndefined();
    expect(pseudoInput(NEW_COLUMN_URI)).toBeUndefined();
  });

  it("are never claimed as a shared instance", () => {
    const claims = computeClaims(
      [
        {
          path: "fn.a",
          label: "a",
          selection: { resources: { "": columnUri("0") } },
        },
        {
          path: "fn.b",
          label: "b",
          selection: { resources: { "": columnUri("0") } },
        },
      ],
      {},
      new Map(),
    );
    expect(claims.size).toBe(0);
  });
});

describe("withPseudoSources", () => {
  it("offers the panel only other slots whose type fits", () => {
    const sources = withPseudoSources(undefined, {
      functionParameters,
      bindings: NO_BINDINGS,
    });
    expect(sources.functionSlots).toEqual({
      taskId: [inputUri("function", "title")],
      title: [inputUri("function", "taskId")],
    });
    expect(sources.resources.map(r => [r.label, r.group])).toContainEqual([
      "= title",
      ["Prompt inputs"],
    ]);
  });

  it("never offers a slot that would close a cycle", () => {
    const sources = withPseudoSources(undefined, {
      functionParameters,
      bindings: {
        functionInputs: {
          title: { kind: "input", half: "function", path: "taskId" },
        },
        executeInputs: {},
      },
    });
    expect(sources.functionSlots.taskId).toBeUndefined();
  });

  it("offers the eval editor every column and slot, and a new column", () => {
    const sources = withPseudoSources(undefined, {
      functionParameters,
      bindings: NO_BINDINGS,
      fields: [{ id: "0", def: def("question", "string") }],
      offerMismatches: true,
      newColumn: true,
    });
    expect(sources.functionSlots.count).toEqual([
      columnUri("0"),
      inputUri("function", "taskId"),
      inputUri("function", "title"),
      NEW_COLUMN_URI,
    ]);
  });

  it("offers columns and slots to a resource's arguments", () => {
    const seeded: ResourceInfo = {
      uri: "db.ts#seeded",
      label: "seeded",
      scope: "run",
      parameters: [def("title", "string")],
    };
    const sources = withPseudoSources(
      { resources: [seeded], functionSlots: {}, executeSlots: {} },
      {
        functionParameters,
        bindings: NO_BINDINGS,
        fields: [{ id: "0", def: def("t", "string") }],
      },
    );
    expect(sources.resourceSlots?.["db.ts#seeded"]?.title).toEqual([
      columnUri("0"),
      inputUri("function", "taskId"),
      inputUri("function", "title"),
    ]);
  });
});

describe("checkParameterSources", () => {
  it("offers every column and slot to each parameter", () => {
    const sources = checkParameterSources([def("expected", "string")], {
      functionParameters,
      fields: [{ id: "0", def: def("question", "string") }],
    });
    expect(sources.functionSlots.expected).toHaveLength(5);
    expect(sources.functionSlots.expected).toContain(NEW_COLUMN_URI);
  });
});

describe("describePseudoSource", () => {
  const options = {
    functionParameters,
    fields: [{ id: "0", def: def("n", "number") }],
  };

  it("warns of a type mismatch", () => {
    expect(
      describePseudoSource(columnUri("0"), def("x", "string").type, options),
    ).toEqual({ note: "column of each row", warning: "number into string" });
    expect(
      describePseudoSource(
        inputUri("function", "taskId"),
        def("x", "string").type,
        options,
      ),
    ).toEqual({ note: "same value as that input" });
  });

  it("says when the column or slot is gone", () => {
    expect(
      describePseudoSource(columnUri("9"), def("x", "string").type, options),
    ).toEqual({ note: "column no longer exists" });
  });
});
