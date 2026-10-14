// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type {
  NormalizedPrompt,
  PropDefinition,
  ResourceInfo,
} from "../../shared/types";
import {
  addFieldRequest,
  choiceFor,
  defaultFieldName,
  type FieldTypeChoice,
  parameterOptionGroups,
  resourceInputGroups,
} from "./dataset-field-options";

const param = (name: string, syntax: string): PropDefinition => ({
  name,
  type: { kind: "primitive", syntax },
  optional: false,
});

function prompt(
  id: string,
  functionParameters: PropDefinition[],
  executeParameters?: PropDefinition[],
): NormalizedPrompt {
  return {
    id,
    providerId: "files",
    name: id.split("#")[1],
    functionParameters,
    ...(executeParameters && { executeParameters }),
  } as NormalizedPrompt;
}

const CLASSIFY = prompt("a.ts#classify", [param("ticket", "string")]);
const PLAN = prompt(
  "odin.ts#plan",
  [param("taskId", "TaskId")],
  [param("toolsContext", "ToolsContext")],
);
const EMPTY = prompt("b.ts#empty", []);

const resource = (
  uri: string,
  extra: Partial<ResourceInfo> = {},
): ResourceInfo => ({ uri, label: uri.split("#")[1], scope: "run", ...extra });

/** `base` with `resources` in scope. */
const seeing = (
  base: NormalizedPrompt,
  ...resources: ResourceInfo[]
): NormalizedPrompt => ({
  ...base,
  inputSources: { resources, functionSlots: {}, executeSlots: {} },
});

const DB = resource("db.ts#db", { parameters: [param("tenantId", "string")] });

describe("parameterOptionGroups", () => {
  it("groups parameters by prompt, function before execute, skipping prompts with none", () => {
    const groups = parameterOptionGroups([CLASSIFY, EMPTY, PLAN]);
    expect(
      groups.map(g => [
        g.label,
        g.linked,
        g.options.map(o => o.half + ":" + o.path),
      ]),
    ).toEqual([
      ["classify", false, ["function:ticket"]],
      ["plan", false, ["function:taskId", "execute:toolsContext"]],
    ]);
    expect(groups[1].options[0]).toMatchObject({
      providerId: "files",
      promptId: "odin.ts#plan",
      def: param("taskId", "TaskId"),
    });
  });

  it("lists the linked prompt first", () => {
    const groups = parameterOptionGroups([CLASSIFY, PLAN], {
      id: "odin.ts#plan",
      providerId: "files",
    });
    expect(groups.map(g => [g.label, g.linked])).toEqual([
      ["plan", true],
      ["classify", false],
    ]);
  });

  it("gives every option a distinct value", () => {
    // Same parameter name in both halves.
    const both = prompt("c.ts#x", [param("ctx", "A")], [param("ctx", "A")]);
    const values = parameterOptionGroups([both, CLASSIFY]).flatMap(g =>
      g.options.map(o => o.value),
    );
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("choiceFor", () => {
  const groups = parameterOptionGroups([PLAN]);

  it("reads a primitive type or a parameter option back from its value", () => {
    expect(choiceFor("number", groups)).toEqual({
      kind: "primitive",
      type: "number",
    });
    const option = groups[0].options[1];
    expect(choiceFor(option.value, groups)).toEqual({
      kind: "parameter",
      option,
    });
    expect(choiceFor("Task", groups)).toBeUndefined();
  });
});

describe("addFieldRequest", () => {
  const [taskId] = parameterOptionGroups([PLAN])[0].options;
  const fromTaskId: FieldTypeChoice = { kind: "parameter", option: taskId };

  it("builds a primitive request only once there's a name", () => {
    const choice: FieldTypeChoice = { kind: "primitive", type: "boolean" };
    expect(addFieldRequest("  ", choice)).toBeUndefined();
    expect(addFieldRequest(" done ", choice)).toEqual({
      name: "done",
      type: "boolean",
    });
    expect(defaultFieldName(choice)).toBe("");
  });

  it("sends a parameter as a reference, named after it by default", () => {
    expect(defaultFieldName(fromTaskId)).toBe("taskId");
    const reference = {
      from: {
        providerId: "files",
        promptId: "odin.ts#plan",
        half: "function",
        path: "taskId",
      },
    };
    expect(addFieldRequest("", fromTaskId)).toEqual(reference);
    expect(addFieldRequest("taskId", fromTaskId)).toEqual(reference);
    expect(addFieldRequest("expectedTaskId", fromTaskId)).toEqual({
      ...reference,
      name: "expectedTaskId",
    });
  });
});

describe("resourceInputGroups", () => {
  it("lists a resource's inputs once, under the first prompt that sees it", () => {
    const groups = resourceInputGroups([
      seeing(CLASSIFY, DB),
      seeing(PLAN, DB),
    ]);
    expect(groups.map(g => [g.label, g.options.map(o => o.path)])).toEqual([
      ["db", ["tenantId"]],
    ]);
    expect(groups[0].options[0]).toMatchObject({
      providerId: "files",
      promptId: "a.ts#classify",
      resourceUri: "db.ts#db",
      def: param("tenantId", "string"),
    });
  });

  it("skips resources with no inputs, an error, or a parent", () => {
    expect(
      resourceInputGroups([
        seeing(
          PLAN,
          resource("a.ts#plain"),
          resource("b.ts#broken", {
            error: "boom",
            parameters: [param("x", "string")],
          }),
          resource("db.ts#db.users", {
            parent: "db.ts#db",
            parameters: [param("x", "string")],
          }),
        ),
        CLASSIFY,
      ]),
    ).toEqual([]);
  });

  it("is read back by choiceFor and sent as a resource reference", () => {
    const groups = resourceInputGroups([seeing(PLAN, DB)]);
    const [option] = groups[0].options;
    const choice = choiceFor(
      option.value,
      parameterOptionGroups([PLAN]),
      groups,
    );
    expect(choice).toEqual({ kind: "resource", option });
    if (!choice) throw new Error("not found");
    expect(defaultFieldName(choice)).toBe("tenantId");
    const reference = {
      from: {
        providerId: "files",
        promptId: "odin.ts#plan",
        resourceUri: "db.ts#db",
        path: "tenantId",
      },
    };
    expect(addFieldRequest("", choice)).toEqual(reference);
    expect(addFieldRequest("tenant", choice)).toEqual({
      ...reference,
      name: "tenant",
    });
  });
});
