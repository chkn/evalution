// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VercelAISDK } from "../sdk/vercel-ai-sdk/index.ts";
import { CONFIG_FILE_RELATIVE_PATH } from "../shared/setup-task.ts";
import {
  executeSetupStep,
  isBinaryOnPath,
  isPackageInstalled,
  resolveSetupTasks,
  SetupStepNotFoundError,
} from "./setup-tasks.ts";

const TASK_ID = VercelAISDK.setupTask.id;
const CONFIG_STEP = VercelAISDK.setupTask.steps.find(
  s => s.kind === "create_config",
)!;
const INSTALL_STEP = VercelAISDK.setupTask.steps.find(
  s => s.kind === "install_package",
)!;
const STEP_ID = CONFIG_STEP.id;
const CONFIG_CONTENTS = (CONFIG_STEP as { contents: string }).contents;

describe("executeSetupStep", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-setup-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes the config file from the step definition", async () => {
    const result = await executeSetupStep(root, TASK_ID, STEP_ID);
    expect(result).toEqual({ path: CONFIG_FILE_RELATIVE_PATH });

    const written = await fs.readFile(
      path.join(root, CONFIG_FILE_RELATIVE_PATH),
      "utf8",
    );
    expect(written).toBe(CONFIG_CONTENTS);
  });

  it("creates the .evalution directory when missing", async () => {
    await executeSetupStep(root, TASK_ID, STEP_ID);
    const stat = await fs.stat(path.join(root, ".evalution"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("refuses to overwrite an existing config file", async () => {
    await executeSetupStep(root, TASK_ID, STEP_ID);
    await expect(executeSetupStep(root, TASK_ID, STEP_ID)).rejects.toThrow(
      "already exists",
    );

    // The original template must be left intact.
    const written = await fs.readFile(
      path.join(root, CONFIG_FILE_RELATIVE_PATH),
      "utf8",
    );
    expect(written).toBe(CONFIG_CONTENTS);
  });

  it("throws SetupStepNotFoundError for an unknown task", async () => {
    await expect(
      executeSetupStep(root, "nope", STEP_ID),
    ).rejects.toBeInstanceOf(SetupStepNotFoundError);
  });

  it("throws SetupStepNotFoundError for an unknown step", async () => {
    await expect(
      executeSetupStep(root, TASK_ID, "nope"),
    ).rejects.toBeInstanceOf(SetupStepNotFoundError);
  });

  it("refuses to execute command/install steps (terminal pass pending)", async () => {
    await expect(
      executeSetupStep(root, TASK_ID, INSTALL_STEP.id),
    ).rejects.toThrow("not yet supported");
  });
});

describe("isPackageInstalled", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-pkg-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is false when the package is absent", () => {
    expect(isPackageInstalled(root, "@scope/thing")).toBe(false);
  });

  it("is true when node_modules/<pkg>/package.json exists", async () => {
    await fs.mkdir(path.join(root, "node_modules", "@scope", "thing"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "node_modules", "@scope", "thing", "package.json"),
      "{}",
    );
    expect(isPackageInstalled(root, "@scope/thing")).toBe(true);
  });

  it("walks up to a hoisted node_modules", async () => {
    const nested = path.join(root, "a", "b");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "hoisted"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "node_modules", "hoisted", "package.json"),
      "{}",
    );
    expect(isPackageInstalled(nested, "hoisted")).toBe(true);
  });
});

describe("resolveSetupTasks", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-resolve-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("marks the config step completed once the file exists", async () => {
    const before = resolveSetupTasks(root).sdk.find(t => t.id === TASK_ID)!;
    expect(before.steps.find(s => s.kind === "create_config")!.completed).toBe(
      false,
    );

    await executeSetupStep(root, TASK_ID, STEP_ID);

    const after = resolveSetupTasks(root).sdk.find(t => t.id === TASK_ID)!;
    expect(after.steps.find(s => s.kind === "create_config")!.completed).toBe(
      true,
    );
  });

  it("marks the install step completed once the package is present", async () => {
    const before = resolveSetupTasks(root).sdk.find(t => t.id === TASK_ID)!;
    const install = before.steps.find(s => s.kind === "install_package")!;
    expect(install.completed).toBe(false);

    const pkgDir = path.join(
      root,
      "node_modules",
      (install as { package: string }).package,
    );
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), "{}");

    const after = resolveSetupTasks(root).sdk.find(t => t.id === TASK_ID)!;
    expect(after.steps.find(s => s.kind === "install_package")!.completed).toBe(
      true,
    );
  });

  it("includes the coding-agent tasks alongside the SDKs", () => {
    const { agent } = resolveSetupTasks(root);
    expect(agent.map(t => t.id)).toContain("claude-code");
    expect(agent.map(t => t.id)).toContain("codex");
  });

  it("disables a coding agent exactly when its CLI is not on PATH", () => {
    const { agent } = resolveSetupTasks(root);
    for (const task of agent) {
      const step = task.steps[0];
      const bin =
        step.kind === "run_command" ? step.command.split(/\s+/)[0] : "";
      if (isBinaryOnPath(bin)) {
        expect(step.disabledReason).toBeUndefined();
      } else {
        expect(step.disabledReason).toBe(`${bin} not found in PATH`);
      }
    }
  });
});

describe("isBinaryOnPath", () => {
  it("finds an executable present on PATH", () => {
    // `node` is on PATH whenever this test suite runs.
    expect(isBinaryOnPath("node")).toBe(true);
  });

  it("is false for an executable that doesn't exist", () => {
    expect(isBinaryOnPath("evalution-no-such-binary-xyzzy")).toBe(false);
  });
});
