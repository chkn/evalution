// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { type ReactElement, useEffect, useState } from "react";
import {
  CONFIG_DOCS_URL,
  SETUP_STEP_DONE_EVENT,
  type SetupStep as SetupStepDef,
  type SetupStepDoneDetail,
  type SetupTask,
  setupStepCommand,
} from "../../../shared/setup-task";
import { executeSetupStep, getSetupTasks } from "../../api";
import ProviderIcon from "../ProviderIcon";
import { CopyBox } from "./CopyBox";
import type { WizardStepProps } from "./types";

/** URL for requesting support for an AI SDK we don't list. */
const OTHER_SDK_URL =
  "https://github.com/chkn/evalution/issues/new?template=sdk-request.yml";

/** URL for requesting support for a coding agent we don't list. */
const OTHER_AGENT_URL =
  "https://github.com/chkn/evalution/issues/new?template=agent-request.yml";

/** Guide the user is pointed at once their project is configured. */
const MANUAL_SETUP_URL = "https://evalut.io/n/docs/setup";

type SetupStepProps = Pick<WizardStepProps, "onOpenTerminal">;

/**
 * Project setup step: offers two paths — hand the work to a coding agent, or
 * set things up manually by choosing an AI SDK and working through its ordered
 * steps. There is no "next" action; the wizard advances on its own once the
 * config file is detected and loaded by the server.
 */
export function SetupStep({ onOpenTerminal }: SetupStepProps) {
  const [agentTasks, setAgentTasks] = useState<SetupTask[]>([]);
  const [tasks, setTasks] = useState<SetupTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    getSetupTasks()
      .then(({ agent, sdk }) => {
        if (cancelled) return;
        setAgentTasks(agent);
        setTasks(sdk);
        setSelectedId(prev => prev ?? sdk[0]?.id ?? null);
      })
      .catch(() => {
        /* leave the picker empty; the agent path still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A terminal step that exits 0 announces itself; mark it done so the list
  // reflects completion (e.g. an install flips to "Installed") without a refetch.
  useEffect(() => {
    const onDone = (e: Event) => {
      const { stepId } = (e as CustomEvent<SetupStepDoneDetail>).detail;
      setDone(prev => new Set(prev).add(stepId));
    };
    window.addEventListener(SETUP_STEP_DONE_EVENT, onDone);
    return () => window.removeEventListener(SETUP_STEP_DONE_EVENT, onDone);
  }, []);

  const selected = tasks.find(t => t.id === selectedId);

  const isDone = (step: SetupStepDef, i: number) =>
    (step.completed || done.has(step.id)) &&
    // Don't mark config as done if it's the last step, because we should automatically detect it and redirect
    (step.kind !== "create_config" || i < selected!.steps.length - 1);

  const isRunning = (step: SetupStepDef, i: number) =>
    running.has(step.id) ||
    (step.kind === "create_config" &&
      (step.completed || done.has(step.id)) &&
      i === selected!.steps.length - 1);

  const toggleExpanded = (stepId: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(stepId) ? next.delete(stepId) : next.add(stepId);
      return next;
    });

  const handleCreate = async (step: SetupStepDef) => {
    if (!selected) return;
    setRunning(prev => new Set(prev).add(step.id));
    setErrors(prev => {
      const { [step.id]: _, ...rest } = prev;
      return rest;
    });
    try {
      await executeSetupStep(selected.id, step.id);
      setDone(prev => new Set(prev).add(step.id));
    } catch (e: any) {
      setErrors(prev => ({ ...prev, [step.id]: e.message }));
    } finally {
      setRunning(prev => {
        const next = new Set(prev);
        next.delete(step.id);
        return next;
      });
    }
  };

  return (
    <div className="setup-split">
      {/* ── Top: let a coding agent do it ── */}
      <section className="setup-pane">
        <h3>Set up with a coding agent</h3>
        <div
          className="setup-sdk-options"
          role="group"
          aria-label="Coding agent"
        >
          {agentTasks.map(task => {
            // Each agent task is a single run_command step that launches its CLI.
            const step = task.steps[0];
            const disabledReason = step?.disabledReason;
            const taskTitle = disabledReason ?? `Run ${task.label}`;
            // A disabled <button> doesn't surface a hover tooltip, so the
            // reason lives on the wrapping span instead.
            return (
              <span
                key={task.id}
                className="setup-agent-option-wrap"
                title={taskTitle}
              >
                <button
                  type="button"
                  className="setup-sdk-option"
                  disabled={!!disabledReason}
                  title={taskTitle}
                  onClick={() => {
                    if (!step || step.kind === "create_config") return;
                    onOpenTerminal?.(
                      task.id,
                      step.id,
                      setupStepCommand(step),
                      task.label,
                    );
                  }}
                >
                  <span className="setup-sdk-icon" aria-hidden="true">
                    <ProviderIcon provider={task.icon} size={20} />
                  </span>
                  <span>{task.label}</span>
                </button>
              </span>
            );
          })}
          <a
            className="setup-sdk-option setup-sdk-option-link"
            href={OTHER_AGENT_URL}
            target="_blank"
            rel="noopener"
          >
            Other
          </a>
        </div>
      </section>

      <div className="setup-divider">
        <span>or set up manually</span>
      </div>

      {/* ── Bottom: manual setup ── */}
      <section className="setup-pane">
        <h3>
          Manual setup —{" "}
          <a
            className="welcome-link"
            href={MANUAL_SETUP_URL}
            target="_blank"
            rel="noopener"
          >
            full docs ↗
          </a>
        </h3>

        <div className="welcome-field">
          <div className="setup-sdk-options" role="group" aria-label="AI SDK">
            {tasks.map(task => (
              <button
                key={task.id}
                type="button"
                className={`setup-sdk-option${task.id === selectedId ? " setup-sdk-option-selected" : ""}`}
                aria-pressed={task.id === selectedId}
                onClick={() => setSelectedId(task.id)}
              >
                <span className="setup-sdk-icon" aria-hidden="true">
                  <ProviderIcon provider={task.icon} size={20} />
                </span>
                <span>{task.label}</span>
              </button>
            ))}
            <a
              className="setup-sdk-option setup-sdk-option-link"
              href={OTHER_SDK_URL}
              target="_blank"
              rel="noopener"
            >
              Other
            </a>
          </div>
        </div>

        {selected && (
          <ol className="setup-steps">
            {selected.steps.map((step, i) => (
              <li
                key={step.id}
                className={`setup-step${isDone(step, i) ? " setup-step-done" : ""}${isRunning(step, i) ? " setup-step-running" : ""}`}
              >
                <div className="setup-step-row">
                  <span className="setup-step-label">
                    {renderStepLabel(step)}
                    {step.kind === "create_config" && (
                      <button
                        type="button"
                        className="setup-step-expand welcome-link"
                        onClick={() => toggleExpanded(step.id)}
                      >
                        {expanded.has(step.id) ? "Hide" : "Show"}
                      </button>
                    )}
                  </span>
                  <span className="setup-step-action">
                    {renderStepAction(step, {
                      done: isDone(step, i),
                      running: isRunning(step, i),
                      onCreate: () => handleCreate(step),
                      onRun: () => {
                        if (step.kind === "create_config" || !selected) return;
                        const label =
                          step.kind === "install_package"
                            ? `Install ${step.package}`
                            : step.label;
                        onOpenTerminal?.(
                          selected.id,
                          step.id,
                          setupStepCommand(step),
                          label,
                        );
                      },
                    })}
                  </span>
                </div>
                {step.kind === "create_config" && expanded.has(step.id) && (
                  <div className="setup-config-snippet">
                    <CopyBox text={step.contents} multiline />
                    <a
                      className="welcome-link setup-config-docs"
                      href={CONFIG_DOCS_URL}
                      target="_blank"
                      rel="noopener"
                    >
                      Config docs ↗
                    </a>
                  </div>
                )}
                {errors[step.id] && (
                  <div className="setup-file-status setup-file-error">
                    {errors[step.id]}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** The instruction text shown for a step (e.g. "Create `config.ts`"). */
function renderStepLabel(step: SetupStepDef) {
  switch (step.kind) {
    case "create_config":
      return (
        <>
          Create config: <code>{step.path}</code>
        </>
      );
    case "install_package":
      return (
        <>
          Install package: <code>{step.package}</code>
        </>
      );
    case "run_command":
      return (
        <>
          Run <code>{step.command}</code>
        </>
      );
  }
}

interface StepActionState {
  done: boolean;
  running: boolean;
  onCreate: () => void;
  onRun: () => void;
}

/**
 * Wraps a disabled action button in a titled span so its `disabledReason`
 * surfaces on hover — a disabled `<button>` swallows pointer events and won't
 * show its own `title`. Returns the button untouched when there's no reason.
 */
function withDisabledReason(reason: string | undefined, button: ReactElement) {
  return reason ? (
    <span className="setup-step-action-wrap" title={reason}>
      {button}
    </span>
  ) : (
    button
  );
}

/** Small blue glyph shown to the left of an action button's label. */
function StepActionIcon({ kind }: { kind: SetupStepDef["kind"] }) {
  const props = {
    className: "setup-step-btn-icon",
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "create_config":
      // A document with a plus — creating the config file.
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M12 12v6M9 15h6" />
        </svg>
      );
    case "install_package":
      // A download arrow into a tray — installing the package.
      return (
        <svg {...props}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
      );
    case "run_command":
      // A play triangle — running the command.
      return (
        <svg {...props}>
          <path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

/** The right-hand action for a step: create/run button or a done indicator. */
function renderStepAction(step: SetupStepDef, s: StepActionState) {
  if (step.kind === "create_config") {
    if (s.done) {
      return (
        <span className="setup-step-status setup-file-created">Created</span>
      );
    }
    return withDisabledReason(
      step.disabledReason,
      <button
        type="button"
        className="setup-step-btn"
        onClick={s.onCreate}
        disabled={s.running || !!step.disabledReason}
        title={step.disabledReason}
      >
        <StepActionIcon kind={step.kind} />
        {s.running ? "Creating…" : "Create"}
      </button>,
    );
  }

  // run_command / install_package
  if (step.kind === "install_package" && s.done) {
    return (
      <span className="setup-step-status setup-file-created">Installed</span>
    );
  }
  const taskTitle = step.disabledReason ?? setupStepCommand(step);
  return withDisabledReason(
    step.disabledReason,
    <button
      type="button"
      className="setup-step-btn"
      onClick={s.onRun}
      disabled={!!step.disabledReason}
      title={taskTitle}
    >
      <StepActionIcon kind={step.kind} />
      {step.kind === "install_package" ? "Install" : "Run"}
    </button>,
  );
}
