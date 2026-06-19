// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AGENT_REGISTRY,
  findSetupStep as findAgentSetupStep,
} from "../agent/registry.ts";
import {
  AI_SDK_REGISTRY,
  findSetupStep as findSdkSetupStep,
} from "../sdk/registry.ts";
import {
  type SetupCreateConfigStep,
  type SetupStep,
  type SetupTask,
  setupStepCommand,
} from "../shared/setup-task.ts";

/** Onboarding tasks split by source, as returned to the client. */
export interface ResolvedSetupTasks {
  /** Coding-agent launchers (see `../agent/registry.ts`). */
  agent: SetupTask[];
  /** Manual AI-SDK setups (see `../sdk/registry.ts`). */
  sdk: SetupTask[];
}

/**
 * Resolves a setup step across both the agent and SDK registries by its
 * `taskId`/`stepId`, or `undefined` if neither knows it.
 */
export function findSetupStep(
  taskId: string,
  stepId: string,
): SetupStep | undefined {
  return findSdkSetupStep(taskId, stepId) ?? findAgentSetupStep(taskId, stepId);
}

/**
 * Thrown when a requested task or step id does not exist in the registry. The
 * route layer maps this to a 404, distinguishing it from execution failures.
 */
export class SetupStepNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupStepNotFoundError";
  }
}

/** Result of {@link executeSetupStep}. */
export interface ExecuteSetupStepResult {
  /** For `create_config`: the project-relative path that was written. */
  path?: string;
}

/**
 * Executes a single onboarding step, resolved from the server-side registry by
 * `taskId`/`stepId`.
 *
 * The client only sends ids; the step definition (file contents, command, ...)
 * comes entirely from {@link AI_SDK_REGISTRY}, so a request can never write
 * arbitrary files or run arbitrary commands.
 *
 * @param rootPath - Absolute path to the project root.
 * @param taskId - Id of the {@link SetupTask} to run a step from.
 * @param stepId - Id of the step within that task.
 * @throws {SetupStepNotFoundError} if the task or step id is unknown.
 * @throws if the step kind is unsupported or execution fails (e.g. the config
 *   file already exists).
 */
export async function executeSetupStep(
  rootPath: string,
  taskId: string,
  stepId: string,
): Promise<ExecuteSetupStepResult> {
  const step = findSetupStep(taskId, stepId);
  if (!step)
    throw new SetupStepNotFoundError(
      `Unknown step '${stepId}' for task '${taskId}'`,
    );

  switch (step.kind) {
    case "create_config":
      return { path: await writeConfigFile(rootPath, step) };
    case "run_command":
    case "install_package":
      // Command steps run in an interactive terminal over WebSocket; execution
      // lands in a later pass.
      throw new Error(`${step.kind} steps are not yet supported`);
    default: {
      // Ensures compile fails if we didn't handle all cases
      const _never: never = step;
      throw new Error();
    }
  }
}

/**
 * Returns the onboarding tasks — coding agents and AI SDKs — with each step's
 * runtime {@link SetupStepBase.completed | completion status} resolved against
 * the project at `rootPath` (config file present, package installed).
 *
 * @param rootPath - Absolute path to the project root.
 */
export function resolveSetupTasks(rootPath: string): ResolvedSetupTasks {
  const resolve = (task: SetupTask): SetupTask => ({
    ...task,
    steps: task.steps.map(step => resolveStepStatus(rootPath, step)),
  });
  return {
    agent: AGENT_REGISTRY.map(resolve),
    sdk: AI_SDK_REGISTRY.map(cls => resolve(cls.setupTask)),
  };
}

/** Adds the runtime `completed` flag to a single step where determinable. */
function resolveStepStatus(rootPath: string, step: SetupStep): SetupStep {
  switch (step.kind) {
    case "create_config":
      return {
        ...step,
        completed: fsSync.existsSync(path.join(rootPath, step.path)),
      };
    case "install_package":
    case "run_command": {
      const result = { ...step };
      if (step.kind === "install_package") {
        result.completed = isPackageInstalled(rootPath, step.package);
      }
      const bin = setupStepCommand(step).split(/\s+/)[0];
      if (bin && !isBinaryOnPath(bin)) {
        result.disabledReason = `${bin} not found in PATH`;
      }
      return result;
    }
    default: {
      // Ensures compile fails if we didn't handle all cases
      const _never: never = step;
      throw new Error();
    }
  }
}

/**
 * Whether an executable named `bin` is resolvable on the current `PATH`. Used
 * to disable coding-agent launchers whose CLI isn't installed. Honours
 * `PATHEXT` on Windows; elsewhere it requires the file to be executable.
 *
 * @param bin - The bare executable name to look for, e.g. `claude`.
 */
export function isBinaryOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        fsSync.accessSync(path.join(dir, bin + ext), fsSync.constants.X_OK);
        return true;
      } catch {
        // Not in this directory, or not executable; keep looking.
      }
    }
  }
  return false;
}

/**
 * Whether `pkg` is installed for the project at `rootPath`, walking up the
 * directory tree to honour hoisted/workspace `node_modules`.
 *
 * @param rootPath - Absolute path to start the search from.
 * @param pkg - The npm package name to look for.
 */
export function isPackageInstalled(rootPath: string, pkg: string): boolean {
  let dir = rootPath;
  while (true) {
    if (fsSync.existsSync(path.join(dir, "node_modules", pkg, "package.json")))
      return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Writes the config file for a `create_config` step, creating parent
 * directories as needed. Refuses to clobber an existing file.
 */
async function writeConfigFile(
  rootPath: string,
  step: SetupCreateConfigStep,
): Promise<string> {
  const filePath = path.join(rootPath, step.path);

  try {
    await fs.access(filePath);
    throw new Error(`${step.path} already exists`);
  } catch (err: any) {
    // ENOENT is the happy path (no existing file); anything else propagates.
    if (err?.code !== "ENOENT") throw err;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, step.contents, "utf8");
  return step.path;
}
