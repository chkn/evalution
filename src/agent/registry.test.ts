// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import {
  AGENT_REGISTRY,
  AGENT_SETUP_PROMPT,
  findSetupStep,
  findSetupTask,
} from "./registry.ts";

describe("coding-agent registry", () => {
  it("offers Claude Code and Codex with a setup-prompt launch step", () => {
    for (const id of AGENT_REGISTRY.map(t => t.id)) {
      const task = findSetupTask(id);
      expect(task).toBeDefined();

      const step = task?.steps[0];
      expect(step?.kind).toBe("run_command");
      if (step?.kind === "run_command") {
        expect(step.command).toContain(AGENT_SETUP_PROMPT);
      }
    }
  });

  it("gives every task a unique id with unique step ids", () => {
    const taskIds = AGENT_REGISTRY.map(t => t.id);
    expect(new Set(taskIds).size).toBe(taskIds.length);

    for (const task of AGENT_REGISTRY) {
      const stepIds = task.steps.map(s => s.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
    }
  });

  it("returns undefined for unknown task and step lookups", () => {
    expect(findSetupTask("nope")).toBeUndefined();
    expect(findSetupStep("claude-code", "nope")).toBeUndefined();
    expect(findSetupStep("nope", "launch")).toBeUndefined();
  });
});
