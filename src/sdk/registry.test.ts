// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { AI_SDK_REGISTRY, findSetupStep, findSetupTask } from "./registry.ts";

describe("AI SDK registry", () => {
  it("offers the Vercel AI SDK with a config-creating step", () => {
    const task = findSetupTask("vercel-ai-sdk");
    expect(task?.label).toBe("AI SDK");

    const step = task?.steps.find(s => s.kind === "create_config");
    expect(step?.kind).toBe("create_config");
    if (step?.kind === "create_config") {
      expect(step.path).toBe(".evalution/config.ts");
      expect(step.contents).toContain("VercelAISDK");
    }

    const install = task?.steps.find(s => s.kind === "install_package");
    expect(install?.kind).toBe("install_package");
    if (install?.kind === "install_package") {
      expect(install.package).toBe("ai");
    }
  });

  it("gives every task a unique id with unique step ids", () => {
    const taskIds = AI_SDK_REGISTRY.map(c => c.setupTask.id);
    expect(new Set(taskIds).size).toBe(taskIds.length);

    for (const cls of AI_SDK_REGISTRY) {
      const stepIds = cls.setupTask.steps.map(s => s.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
    }
  });

  it("returns undefined for unknown task and step lookups", () => {
    expect(findSetupTask("nope")).toBeUndefined();
    expect(findSetupStep("vercel-ai-sdk", "nope")).toBeUndefined();
    expect(findSetupStep("nope", "create-config")).toBeUndefined();
  });
});
