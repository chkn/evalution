/**
 * Shared, dependency-free types describing the onboarding "setup tasks" a user
 * can run to wire up an AI SDK.
 *
 * This module is imported by both the browser client (to render the
 * manual-setup picker) and the server (to define and execute the tasks), so it
 * must stay free of any Node- or DOM-specific imports.
 */

/** Path, relative to the project root, where evalution looks for its config. */
export const CONFIG_FILE_RELATIVE_PATH = '.evalution/config.ts';

/** URL of the configuration documentation, linked from the onboarding wizard. */
export const CONFIG_DOCS_URL = 'https://evalut.io/n/docs/config';

/**
 * Name of the browser `CustomEvent` dispatched (with a {@link SetupStepDoneDetail}
 * payload) when a terminal-run setup step exits successfully, so the manual-setup
 * list can mark the step complete without re-fetching.
 */
export const SETUP_STEP_DONE_EVENT = 'evalution:setup-step-done';

/** Payload of the {@link SETUP_STEP_DONE_EVENT} custom event. */
export interface SetupStepDoneDetail {
  /** Id of the task the completed step belongs to. */
  taskId: string;
  /** Id of the step that completed. */
  stepId: string;
}

/** Fields shared by every {@link SetupStep} kind. */
export interface SetupStepBase {
  /** Stable identifier, unique within the owning {@link SetupTask}. */
  id: string;
  /**
   * Runtime completion status, populated by the server when listing tasks
   * (e.g. the config file already exists, or the package is installed). Absent
   * in the static step definitions held by the registry.
   */
  completed?: boolean;
}

/** Writes evalution's starter config file. */
export interface SetupCreateConfigStep extends SetupStepBase {
  /** Discriminant: this step creates the project config file. */
  kind: 'create_config';
  /** Project-relative path the file will be written to. */
  path: string;
  /**
   * Full contents of the file. Shown to the user as a copyable snippet and
   * written verbatim by the server. This is display data: the server reads it
   * from its own registry, never from a client request.
   */
  contents: string;
}

/**
 * Runs a shell command in the project root, streamed to an interactive
 * terminal so the user can watch it and respond to prompts.
 */
export interface SetupRunCommandStep extends SetupStepBase {
  /** Discriminant: this step runs a shell command. */
  kind: 'run_command';
  /** The command line to run, e.g. `npm run build`. */
  command: string;
  /** Optional human-friendly label shown alongside the command. */
  label?: string;
}

/**
 * Installs an npm package — a specialization of {@link SetupRunCommandStep}
 * that runs `npm i <package>`. The server reports it as already
 * {@link SetupStepBase.completed | completed} when the package is present in
 * the project, so the user can skip it.
 */
export interface SetupInstallPackageStep extends SetupStepBase {
  /** Discriminant: this step installs an npm package. */
  kind: 'install_package';
  /** The npm package to install, e.g. `@evalution/vercel-ai-sdk`. */
  package: string;
}

/**
 * A single executable step within a {@link SetupTask}.
 *
 * Steps are defined server-side and addressed by {@link SetupTask.id} plus the
 * step's `id`; the client references a step only by those ids when asking the
 * server to run it.
 */
export type SetupStep =
  | SetupCreateConfigStep
  | SetupRunCommandStep
  | SetupInstallPackageStep;

/**
 * The shell command a run-style step executes. `install_package` steps map to
 * `npm i <package>`; `run_command` steps carry their command verbatim.
 */
export function setupStepCommand(step: SetupRunCommandStep | SetupInstallPackageStep): string {
  return step.kind === 'install_package' ? `npm i ${step.package}` : step.command;
}

/**
 * A named onboarding task for a single AI SDK: what to show in the manual-setup
 * picker, plus the ordered steps that wire the SDK up.
 */
export interface SetupTask {
  /** Stable identifier, also used as the wire id for this SDK choice. */
  id: string;
  /** Display label for the picker (typically the SDK's product name). */
  label: string;
  /** Icon identifier, mapped to a bundled asset on the client. */
  icon: string;
  /** Ordered steps to run, in display order. */
  steps: SetupStep[];
}
