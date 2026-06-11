// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useState } from "react";
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

/** Setup instructions URL the coding agent is pointed at. */
const AGENT_SETUP_URL = "https://evalut.io/n/docs/setup.md";
/** Placeholder URL for non-Vercel SDK setup guidance. */
const OTHER_SDK_URL = "https://evalut.io/n/docs/other-sdk";

type SetupStepProps = Pick<WizardStepProps, "onOpenTerminal">;

/**
 * Project setup step: offers two paths — hand the work to a coding agent, or
 * set things up manually by choosing an AI SDK and working through its ordered
 * steps. There is no "next" action; the wizard advances on its own once the
 * config file is detected and loaded by the server.
 */
export function SetupStep({ onOpenTerminal }: SetupStepProps) {
  const [tasks, setTasks] = useState<SetupTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    getSetupTasks()
      .then(loaded => {
        if (cancelled) return;
        setTasks(loaded);
        setSelectedId(prev => prev ?? loaded[0]?.id ?? null);
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
        <p className="welcome-subtitle">
          Paste this prompt into your coding agent and let it wire up Evalution
          for you:
        </p>
        <CopyBox text={`Fetch ${AGENT_SETUP_URL}`}>
          Fetch{" "}
          <a
            className="welcome-link"
            href={AGENT_SETUP_URL}
            target="_blank"
            rel="noopener"
          >
            {AGENT_SETUP_URL}
          </a>
        </CopyBox>
      </section>

      <div className="setup-divider">
        <span>or set up manually</span>
      </div>

      {/* ── Bottom: manual setup ── */}
      <section className="setup-pane">
        <h3>Manual setup</h3>

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
                  </span>
                  <span className="setup-step-action">
                    {renderStepAction(step, {
                      done: isDone(step, i),
                      running: isRunning(step, i),
                      expanded: expanded.has(step.id),
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
                      onToggleExpand: () => toggleExpanded(step.id),
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
  expanded: boolean;
  onCreate: () => void;
  onRun: () => void;
  onToggleExpand: () => void;
}

/** The right-hand action(s) for a step: create/run link, done indicator, expander. */
function renderStepAction(step: SetupStepDef, s: StepActionState) {
  if (step.kind === "create_config") {
    return (
      <>
        <button
          type="button"
          className="setup-step-expand welcome-link"
          onClick={s.onToggleExpand}
        >
          {s.expanded ? "Hide" : "Show"}
        </button>
        {s.done ? (
          <span className="setup-step-status setup-file-created">Created</span>
        ) : (
          <button
            type="button"
            className="welcome-link"
            onClick={s.onCreate}
            disabled={s.running}
          >
            {s.running ? "Creating…" : "Create"}
          </button>
        )}
      </>
    );
  }

  // run_command / install_package
  if (step.kind === "install_package" && s.done) {
    return (
      <span className="setup-step-status setup-file-created">Installed</span>
    );
  }
  return (
    <button type="button" className="welcome-link" onClick={s.onRun}>
      {step.kind === "install_package" ? "Install" : "Run"}
    </button>
  );
}
