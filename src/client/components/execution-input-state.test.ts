// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { ExecutionInput, ResourceInfo } from "../../shared/types";
import {
  fromExecutionInput,
  type ResourceArgs,
  resourceArgsFor,
  SELF,
  type SlotSelection,
  toExecutionInput,
} from "./execution-input-state";

const strVal = (value: string): ExecutionInput => ({
  kind: "value",
  value: { kind: "primitive", value },
});

describe("toExecutionInput (specs/resource-arguments.md §C, §J)", () => {
  it("emits an input byte-identical to before arguments existed for a resource with no arguments", () => {
    const selection: SlotSelection = { resources: { [SELF]: "pg.ts#db" } };
    expect(toExecutionInput(selection)).toEqual({
      kind: "resource",
      uri: "pg.ts#db",
    });
    // Same with a `resolveArgs` present but reporting nothing for this uri.
    expect(toExecutionInput(selection, () => undefined)).toEqual({
      kind: "resource",
      uri: "pg.ts#db",
    });
  });

  it("attaches args built by resolveArgs onto the resource node", () => {
    const selection: SlotSelection = { resources: { [SELF]: "pg.ts#seeded" } };
    const args = { title: strVal("Todo app") };
    expect(toExecutionInput(selection, () => args)).toEqual({
      kind: "resource",
      uri: "pg.ts#seeded",
      args,
    });
  });

  it("attaches args to a resource nested inside an object", () => {
    const selection: SlotSelection = {
      resources: { db: "pg.ts#seeded" },
    };
    const args = { title: strVal("x") };
    const result = toExecutionInput(selection, uri =>
      uri === "pg.ts#seeded" ? args : undefined,
    );
    expect(result).toEqual({
      kind: "object",
      properties: { db: { kind: "resource", uri: "pg.ts#seeded", args } },
    });
  });
});

describe("resourceArgsFor (§J)", () => {
  const resourcesByUri = new Map<string, ResourceInfo>([
    [
      "pg.ts#seeded",
      {
        uri: "pg.ts#seeded",
        label: "Seeded task",
        scope: "run",
        parameters: [
          {
            name: "title",
            type: { kind: "primitive", syntax: "string", base: "string" },
            optional: false,
          },
          {
            name: "status",
            type: { kind: "primitive", syntax: "string", base: "string" },
            optional: false,
          },
        ],
      },
    ],
    [
      "pg.ts#titleGen",
      { uri: "pg.ts#titleGen", label: "Title generator", scope: "run" },
    ],
  ]);

  it("builds one ExecutionInput per declared parameter, in declaration order", () => {
    const resourceArgs: ResourceArgs = {
      "pg.ts#seeded": {
        title: { value: { kind: "primitive", value: "Todo app" } },
        status: { value: { kind: "primitive", value: "triaged" } },
      },
    };
    const args = resourceArgsFor("pg.ts#seeded", resourceArgs, resourcesByUri);
    expect(Object.keys(args!)).toEqual(["title", "status"]);
    expect(args!.title).toEqual(strVal("Todo app"));
  });

  it("returns undefined for a resource with no declared parameters", () => {
    expect(
      resourceArgsFor("pg.ts#titleGen", {}, resourcesByUri),
    ).toBeUndefined();
  });

  it("returns undefined when no argument has anything typed in or chosen", () => {
    expect(resourceArgsFor("pg.ts#seeded", {}, resourcesByUri)).toBeUndefined();
  });

  it("resolves an argument that is itself a resource, recursively", () => {
    const resourceArgs: ResourceArgs = {
      "pg.ts#seeded": {
        title: { resources: { [SELF]: "pg.ts#titleGen" } },
      },
    };
    const args = resourceArgsFor("pg.ts#seeded", resourceArgs, resourcesByUri);
    expect(args!.title).toEqual({ kind: "resource", uri: "pg.ts#titleGen" });
  });
});

describe("fromExecutionInput (§I, §J)", () => {
  it("restores a stored selection made before arguments existed, unchanged", () => {
    const input: ExecutionInput = { kind: "resource", uri: "pg.ts#db" };
    const recovered = fromExecutionInput(input);
    expect(recovered.selection).toEqual({ resources: { [SELF]: "pg.ts#db" } });
    expect(recovered.resourceArgs).toEqual({});
  });

  it("recovers a resource's args into the ResourceArgs map, keyed by its uri", () => {
    const input: ExecutionInput = {
      kind: "resource",
      uri: "pg.ts#seeded",
      args: { title: strVal("Todo app") },
    };
    const recovered = fromExecutionInput(input);
    expect(recovered.selection).toEqual({
      resources: { [SELF]: "pg.ts#seeded" },
    });
    expect(recovered.resourceArgs["pg.ts#seeded"]).toEqual({
      title: { value: { kind: "primitive", value: "Todo app" } },
    });
  });

  it("recovers args from a resource nested arbitrarily deep in an object", () => {
    const input: ExecutionInput = {
      kind: "object",
      properties: {
        list_tasks: {
          kind: "object",
          properties: {
            db: {
              kind: "resource",
              uri: "pg.ts#seeded",
              args: { title: strVal("x") },
            },
          },
        },
      },
    };
    const recovered = fromExecutionInput(input);
    expect(recovered.selection.resources).toEqual({
      "list_tasks.db": "pg.ts#seeded",
    });
    expect(recovered.resourceArgs["pg.ts#seeded"]).toEqual({
      title: { value: { kind: "primitive", value: "x" } },
    });
  });

  it("recovers a resource argument that is itself a resource with its own args", () => {
    const input: ExecutionInput = {
      kind: "resource",
      uri: "pg.ts#seeded",
      args: {
        owner: {
          kind: "resource",
          uri: "pg.ts#owner",
          args: { name: strVal("Ada") },
        },
      },
    };
    const recovered = fromExecutionInput(input);
    expect(recovered.resourceArgs["pg.ts#seeded"].owner).toEqual({
      resources: { [SELF]: "pg.ts#owner" },
    });
    expect(recovered.resourceArgs["pg.ts#owner"]).toEqual({
      name: { value: { kind: "primitive", value: "Ada" } },
    });
  });
});

describe("round trip (toExecutionInput ∘ resourceArgsFor, then fromExecutionInput)", () => {
  it("restores a shared-by-uri binding losslessly", () => {
    const resourcesByUri = new Map<string, ResourceInfo>([
      [
        "pg.ts#seeded",
        {
          uri: "pg.ts#seeded",
          label: "Seeded task",
          scope: "run",
          parameters: [
            {
              name: "title",
              type: { kind: "primitive", syntax: "string", base: "string" },
              optional: false,
            },
          ],
        },
      ],
    ]);
    const resourceArgs: ResourceArgs = {
      "pg.ts#seeded": {
        title: { value: { kind: "primitive", value: "Todo app" } },
      },
    };
    const selection: SlotSelection = { resources: { [SELF]: "pg.ts#seeded" } };

    const wire = toExecutionInput(selection, uri =>
      resourceArgsFor(uri, resourceArgs, resourcesByUri),
    )!;
    const recovered = fromExecutionInput(wire);

    expect(recovered.selection).toEqual(selection);
    expect(recovered.resourceArgs).toEqual(resourceArgs);
  });
});
