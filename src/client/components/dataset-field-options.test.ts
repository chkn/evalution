// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { NormalizedPrompt, PropDefinition } from "../../shared/types";
import {
  addFieldRequest,
  choiceFor,
  defaultFieldName,
  type FieldTypeChoice,
  parameterOptionGroups,
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
