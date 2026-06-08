import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AI_SDK_REGISTRY, findSetupStep } from '../sdk/registry.ts';
import type { SetupCreateConfigStep, SetupStep, SetupTask } from '../shared/setup-task.ts';

/**
 * Thrown when a requested task or step id does not exist in the registry. The
 * route layer maps this to a 404, distinguishing it from execution failures.
 */
export class SetupStepNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupStepNotFoundError';
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
  if (!step) throw new SetupStepNotFoundError(`Unknown step '${stepId}' for task '${taskId}'`);

  switch (step.kind) {
    case 'create_config':
      return { path: await writeConfigFile(rootPath, step) };
    case 'run_command':
    case 'install_package':
      // Command steps run in an interactive terminal over WebSocket; execution
      // lands in a later pass.
      throw new Error(`${step.kind} steps are not yet supported`);
  }
}

/**
 * Returns the onboarding tasks with each step's runtime
 * {@link SetupStepBase.completed | completion status} resolved against the
 * project at `rootPath` (config file present, package installed).
 *
 * @param rootPath - Absolute path to the project root.
 */
export function resolveSetupTasks(rootPath: string): SetupTask[] {
  return AI_SDK_REGISTRY.map(cls => ({
    ...cls.setupTask,
    steps: cls.setupTask.steps.map(step => resolveStepStatus(rootPath, step)),
  }));
}

/** Adds the runtime `completed` flag to a single step where determinable. */
function resolveStepStatus(rootPath: string, step: SetupStep): SetupStep {
  switch (step.kind) {
    case 'install_package':
      return { ...step, completed: isPackageInstalled(rootPath, step.package) };
    case 'create_config':
      return { ...step, completed: fsSync.existsSync(path.join(rootPath, step.path)) };
    case 'run_command':
      // No reliable way to know whether an arbitrary command has been run.
      return step;
  }
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
    if (fsSync.existsSync(path.join(dir, 'node_modules', pkg, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Writes the config file for a `create_config` step, creating parent
 * directories as needed. Refuses to clobber an existing file.
 */
async function writeConfigFile(rootPath: string, step: SetupCreateConfigStep): Promise<string> {
  const filePath = path.join(rootPath, step.path);

  try {
    await fs.access(filePath);
    throw new Error(`${step.path} already exists`);
  } catch (err: any) {
    // ENOENT is the happy path (no existing file); anything else propagates.
    if (err?.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, step.contents, 'utf8');
  return step.path;
}
