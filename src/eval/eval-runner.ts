// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runs evals: every (arm, row) through the prompt, then the eval's checks
 * against the run, inside its lease. Server-side, owned by the server like
 * the prompt registry. See `specs/evals.md` §C and §D.
 */

import type { Tracer } from "@opentelemetry/api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  builtinCheck,
  builtinCheckInfos,
  hasCost,
  totalCost,
  traceDuration,
} from "../checks/index.ts";
import type { DatasetProvider } from "../dataset/dataset-provider.ts";
import type { Dataset, DatasetRow } from "../dataset/dataset-types.ts";
import {
  type CheckRun,
  DEFAULT_CHECK_TIMEOUT_MS,
} from "../prompt/playground/check.ts";
import { isStandardSchema } from "../prompt/playground/resource.ts";
import { validateArguments } from "../prompt/playground/resource-registry.ts";
import type {
  PreparedCheck,
  PromptProvider,
  ResolvedPromptInputs,
} from "../prompt/prompt-provider.ts";
import { runPrompt } from "../server/run-prompt.ts";
import { evalProblems } from "../shared/eval-problems.ts";
import type { NormalizedPrompt, PromptRef } from "../shared/types.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";
import type { PromptID, TraceWithSpans } from "../trace/trace-types.ts";
import type { EvalProvider } from "./eval-provider.ts";
import type {
  EvalArm,
  EvalArmSpec,
  EvalCheck,
  EvalCheckResult,
  EvalCounts,
  EvalDefinition,
  EvalRowResult,
  EvalRun,
  EvalRunProgress,
  EvalRunStatus,
} from "./eval-types.ts";
import { emptyCounts } from "./eval-types.ts";
import {
  type JudgedOutcome,
  outcomeFromError,
  outcomeFromReturn,
} from "./outcomes.ts";

/** The default number of (arm, row) runs in flight at once. */
export const DEFAULT_EVAL_CONCURRENCY = 4;

/**
 * An eval can't start: its bindings have problems, or its prompt or dataset
 * is gone. Nothing was recorded. The route answers it with a 400 listing
 * {@link problems}.
 */
export class EvalRunRefusedError extends Error {
  override name = "EvalRunRefusedError";
  /** What's wrong, one line each. */
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The eval can't run: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** What {@link EvalRunner.start} takes. */
export interface StartEvalRunOptions {
  /** Which prompt variants to run. Defaults to head alone. */
  arms?: EvalArmSpec[];
  /** How many (arm, row) runs may be in flight at once. */
  concurrency?: number;
}

/** Options for {@link EvalRunner}. */
export interface EvalRunnerOptions {
  promptProviders: Map<string, PromptProvider>;
  datasetProviders: Map<string, DatasetProvider>;
  /** Where runs' traces land, and are read back from for the checks. */
  traceProvider: TraceProvider;
  traceProviderId: string;
  tracer: Tracer;
  /** Resolves an eval's (possibly global) prompt id to a provider and prompt. */
  resolvePrompt(
    prompt: PromptID,
  ): { providerId: string; promptId: string } | undefined;
  /** Called as each (arm, row) run finishes, and when the run ends. */
  onProgress?(progress: EvalRunProgress): void;
  /**
   * How long to wait for a run's trace to finish arriving, and how often to
   * look. See `specs/evals.md` §D.3.
   *
   * @default { intervalMs: 100, timeoutMs: 10_000 }
   */
  traceWait?: { intervalMs: number; timeoutMs: number };
  /**
   * How long one row's generation may take before the row is an `error`, so
   * a generation that never settles can't hold its worker, and the run,
   * forever.
   *
   * @default DEFAULT_ROW_TIMEOUT_MS
   */
  rowTimeoutMs?: number;
}

/** How long one row's generation may take by default: five minutes. */
export const DEFAULT_ROW_TIMEOUT_MS = 5 * 60_000;

/** One (arm, row) run waiting its turn. */
interface Job {
  arm: EvalArm & { ref: PromptRef };
  row: DatasetRow;
  rowIndex: number;
}

/** A run in flight. */
interface ActiveRun {
  run: EvalRun;
  provider: EvalProvider;
  cancelled: boolean;
  /** Resolves on cancel, so rows in flight stop waiting on their generation. */
  onCancel: Promise<void>;
  cancel: () => void;
  /** Why the run failed, once a worker hit an error it can't record. */
  failure?: unknown;
  done: number;
  counts: EvalCounts;
  drifted: boolean;
  finished: Promise<void>;
}

/** Resolves after `ms`. */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Whether `trace` is complete: over, with every span ended. */
function isComplete(trace: TraceWithSpans | undefined): boolean {
  return (
    !!trace &&
    trace.trace.status !== "running" &&
    trace.spans.every(s => s.endTime !== undefined)
  );
}

/** Why the run failed, from its trace: the first errored span's message. */
function traceError(trace: TraceWithSpans): string {
  const failed = trace.spans.find(s => s.status === "error");
  return failed?.errorMessage ?? "The run failed";
}

/** Rejects with an `error` outcome after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Waits for `settled`, `onCancel`, or `ms`, whichever comes first: resolves
 * `undefined` when `settled` won, else why it didn't.
 */
async function raceSettled(
  settled: Promise<void>,
  onCancel: Promise<unknown>,
  ms: number,
): Promise<"cancelled" | "timeout" | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => undefined),
      onCancel.then(() => "cancelled" as const),
      new Promise<"timeout">(resolve => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs evals. One per server; keeps the runs in flight so they can be
 * cancelled and awaited.
 */
export class EvalRunner {
  private readonly options: EvalRunnerOptions;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: EvalRunnerOptions) {
    this.options = options;
  }

  /**
   * Starts a run of `evalId`: checks it can run, sets up its arms, records
   * the run, and returns it — the rows run in the background.
   *
   * @throws {EvalRunRefusedError} When the eval has problems, or its prompt
   * or dataset is gone.
   */
  async start(
    provider: EvalProvider,
    evalId: string,
    options: StartEvalRunOptions = {},
  ): Promise<EvalRun> {
    const definition = await provider.getEval(evalId);
    if (!definition) throw new EvalRunRefusedError([`No eval ${evalId}`]);

    const target = this.options.resolvePrompt(definition.prompt);
    const promptProvider =
      target && this.options.promptProviders.get(target.providerId);
    const prompt =
      target &&
      (await promptProvider?.getPrompt({ promptId: target.promptId }));
    const datasetProvider = this.options.datasetProviders.get(
      definition.dataset.providerId,
    );
    const dataset = await datasetProvider?.getDataset(definition.dataset.id);
    if (!target || !promptProvider || !prompt) {
      throw new EvalRunRefusedError(["The eval's prompt no longer exists"]);
    }
    if (!datasetProvider || !dataset) {
      throw new EvalRunRefusedError(["The eval's dataset no longer exists"]);
    }

    const checkInfos =
      (await promptProvider.listChecks?.()) ?? builtinCheckInfos();
    const problems = evalProblems(definition.inputs, definition.checks, {
      prompt,
      fields: dataset.fields,
      checks: checkInfos,
    });
    if (problems.length > 0) throw new EvalRunRefusedError(problems);

    const head = await promptProvider.versions?.head();
    const startVersion = head?.clean ? head.commit?.id : undefined;
    const dirty = head ? !head.clean : false;

    const arms = await this.setUpArms(
      promptProvider,
      target.promptId,
      options.arms ?? [{ kind: "head" }],
    );
    const rows = await datasetProvider.listRows(dataset.id);
    const runnable = arms.filter(
      (a): a is EvalArm & { ref: PromptRef } => !!a.ref,
    );
    const concurrency = Math.max(
      1,
      Math.floor(options.concurrency ?? DEFAULT_EVAL_CONCURRENCY),
    );

    const run = await provider.createRun(evalId, {
      definition,
      arms,
      ...(startVersion && { startVersion }),
      dirty,
      concurrency,
      total: runnable.length * rows.length,
    });

    let cancel = () => {};
    const onCancel = new Promise<void>(resolve => {
      cancel = resolve;
    });
    const active: ActiveRun = {
      run,
      provider,
      cancelled: false,
      onCancel,
      cancel,
      done: 0,
      counts: emptyCounts(),
      drifted: false,
      finished: Promise.resolve(),
    };
    this.active.set(run.id, active);

    const jobs: Job[] = runnable.flatMap(arm =>
      rows.map((row, rowIndex) => ({ arm, row, rowIndex })),
    );
    active.finished = this.runJobs(active, jobs, {
      promptProvider,
      prompt,
      dataset,
      definition,
    })
      .then(
        () => (active.cancelled ? "cancelled" : "done") as EvalRunStatus,
        err => {
          console.error(`eval run ${run.id} failed:`, err);
          return "error" as EvalRunStatus;
        },
      )
      .then(async status => {
        await provider
          .finishRun(run.id, status, { drifted: active.drifted })
          .catch(err => console.error("failed to finish eval run:", err));
        this.active.delete(run.id);
        this.progress(active, status);
      });
    this.progress(active, "running");
    return run;
  }

  /**
   * Cancels a run: queued rows become `skipped`, and rows in flight finish
   * and are recorded — or, when their generation doesn't settle within the
   * trace wait, are recorded as errors. Returns whether the run was in flight.
   */
  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.cancelled = true;
    active.cancel();
    return true;
  }

  /** Whether `runId` is in flight. */
  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Whether any run is in flight. */
  isBusy(): boolean {
    return this.active.size > 0;
  }

  /** Resolves once no run is in flight, including runs started meanwhile. */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all(Array.from(this.active.values(), a => a.finished));
    }
  }

  /** Resolves once `runId` has finished, or at once when it isn't running. */
  async finished(runId: string): Promise<void> {
    await this.active.get(runId)?.finished;
  }

  private progress(active: ActiveRun, status: EvalRunStatus): void {
    this.options.onProgress?.({
      runId: active.run.id,
      evalId: active.run.evalId,
      providerId: active.provider.id,
      done: active.done,
      total: active.run.total,
      counts: { ...active.counts },
      status,
    });
  }

  /**
   * Sets up each arm on head's code (`specs/evals.md` §C): head as is, a WIP
   * frozen, a named variation rebased. A conflicted rebase fails that arm,
   * listing the conflicts; the others proceed.
   */
  private async setUpArms(
    provider: PromptProvider,
    promptId: string,
    specs: EvalArmSpec[],
  ): Promise<EvalArm[]> {
    return Promise.all(
      specs.map(async (spec, i): Promise<EvalArm> => {
        const id = `a${i}`;
        if (spec.kind === "head") {
          return { id, label: "Working tree", spec, ref: { promptId } };
        }
        const info = await provider.variations
          ?.get(spec.variation)
          .catch(() => undefined);
        const label =
          spec.kind === "wip"
            ? "Unsaved edits"
            : (spec.label ?? info?.names?.[0] ?? "Variation");
        if (!provider.variations) {
          return {
            id,
            label,
            spec,
            error: "This prompt's provider has no variations",
          };
        }
        try {
          const rebased = await provider.variations.rebase(spec.variation);
          if (!rebased.ok) {
            return {
              id,
              label,
              spec,
              error: "The variation conflicts with the working tree",
              conflicts: rebased.conflicts,
            };
          }
          return {
            id,
            label,
            spec,
            ref: { promptId, variation: rebased.variation.id },
            rebasedTo: rebased.variation.id,
          };
        } catch (err: any) {
          return { id, label, spec, error: err?.message ?? String(err) };
        }
      }),
    );
  }

  /** Runs `jobs` through a queue, `concurrency` at a time. */
  private async runJobs(
    active: ActiveRun,
    jobs: Job[],
    ctx: RowContext,
  ): Promise<void> {
    let next = 0;
    const worker = async () => {
      // A failed worker stops the others too: the run is then over, and
      // they'd be spending model calls on a run marked `error`.
      while (next < jobs.length && active.failure === undefined) {
        const job = jobs[next++]!;
        try {
          const results = active.cancelled
            ? this.skipped(active, ctx.definition, job, "The run was cancelled")
            : await this.runRow(active, job, ctx);
          await active.provider.recordRowResult(results.row);
          await active.provider.recordCheckResults(results.checks);
          active.done++;
          for (const c of results.checks) active.counts[c.outcome]++;
          this.progress(active, "running");
        } catch (err) {
          active.failure ??= err;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(active.run.concurrency, jobs.length) },
        worker,
      ),
    );
    if (active.failure !== undefined) throw active.failure;
  }

  /** A row that never ran, and its checks all `skipped`. */
  private skipped(
    active: ActiveRun,
    definition: EvalDefinition,
    job: Job,
    reason: string,
    status: EvalRowResult["status"] = "skipped",
  ): RowResults {
    const key = {
      runId: active.run.id,
      armId: job.arm.id,
      rowId: job.row.id,
      sample: 0,
    };
    return {
      row: {
        ...key,
        rowIndex: job.rowIndex,
        rowCells: job.row.cells,
        status,
        error: reason,
      },
      checks: definition.checks.map(c => ({
        ...key,
        checkId: c.id,
        outcome: "skipped",
      })),
    };
  }

  /** One (arm, row) run, per `specs/evals.md` §D.1. */
  private async runRow(
    active: ActiveRun,
    job: Job,
    { promptProvider, prompt, dataset, definition }: RowContext,
  ): Promise<RowResults> {
    const { inputs } = definition;
    const key = {
      runId: active.run.id,
      armId: job.arm.id,
      rowId: job.row.id,
      sample: 0,
    };

    // 1. A required slot bound straight to a cell this row leaves empty: the
    // row is an error, and nothing runs.
    for (const [half, params, bindings] of [
      ["function", prompt.functionParameters, inputs.functionInputs],
      ["execute", prompt.executeParameters ?? [], inputs.executeInputs],
    ] as const) {
      for (const param of params) {
        const binding = bindings[param.name];
        if (
          !param.optional &&
          binding?.kind === "dataset" &&
          job.row.cells[binding.field] === undefined
        ) {
          const field =
            dataset.fields.find(f => f.id === binding.field)?.def.name ??
            binding.field;
          return this.skipped(
            active,
            definition,
            job,
            `Row ${job.rowIndex + 1} has no '${field}' for required ${half === "execute" ? "execute input" : "input"} '${param.name}'`,
            "error",
          );
        }
      }
    }

    // 2. Resolve and execute.
    let resolved: ResolvedPromptInputs;
    let traceId: string;
    let settled: Promise<void>;
    let version: string | undefined;
    let variation: string | undefined;
    try {
      const ran = await runPrompt(
        promptProvider,
        job.arm.ref,
        prompt,
        {
          // Positional, as the route takes them. An unbound optional
          // parameter is `undefined`, as the panel sends it.
          functionInputs: prompt.functionParameters.map(
            p =>
              inputs.functionInputs[p.name] ?? {
                kind: "value",
                value: { kind: "primitive", value: undefined },
              },
          ),
          executeInputs: inputs.executeInputs,
        },
        {
          tracer: this.options.tracer,
          traceProviderId: this.options.traceProviderId,
          row: job.row,
          holdLease: true,
        },
      );
      resolved = ran.resolved;
      settled = ran.settled;
      traceId = ran.response.traceId;
      version = ran.response.version;
      variation = ran.response.variation;
    } catch (err: any) {
      return this.skipped(
        active,
        definition,
        job,
        err?.message ?? String(err),
        "error",
      );
    }

    try {
      // 3. Wait for the generation to settle — but not forever, nor for long
      // after a cancel: a row in flight gets as long to finish as a trace
      // gets to arrive — then for its trace.
      const timeoutMs = this.options.rowTimeoutMs ?? DEFAULT_ROW_TIMEOUT_MS;
      const stopped = await raceSettled(
        settled,
        active.onCancel.then(() => sleep(this.traceWait().timeoutMs)),
        timeoutMs,
      );
      if (stopped) {
        return this.skipped(
          active,
          definition,
          job,
          stopped === "cancelled"
            ? "The run was cancelled before this row finished"
            : `The prompt didn't finish within ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}`,
          "error",
        );
      }
      const { trace, incomplete } = await this.waitForTrace(traceId);
      const status: "ok" | "error" =
        trace.trace.status === "error" ? "error" : "ok";
      const error = status === "error" ? traceError(trace) : undefined;

      // A row that ran on another commit, or on uncommitted changes, after
      // a clean start: the working tree changed mid-run.
      if (
        active.run.startVersion !== undefined &&
        version !== active.run.startVersion
      ) {
        active.drifted = true;
      }

      // 4. Checks, in the run's lease, concurrently.
      const checkRun: CheckRun = {
        trace,
        row: job.row,
        status,
        ...(error && { error }),
        ...(incomplete && { traceIncomplete: true }),
      };
      const checks = await Promise.all(
        definition.checks.map(async (check): Promise<EvalCheckResult> => {
          const started = Date.now();
          const judged = await this.judge(check, resolved, checkRun);
          return {
            ...key,
            checkId: check.id,
            ...judged,
            durationMs: Date.now() - started,
          };
        }),
      );

      const duration = traceDuration(trace);
      return {
        row: {
          ...key,
          rowIndex: job.rowIndex,
          rowCells: job.row.cells,
          traceProviderId: this.options.traceProviderId,
          traceId,
          ...(version && { version }),
          ...(variation && { variation }),
          status,
          ...(error && { error }),
          ...(hasCost(trace) && { costUsd: totalCost(trace) }),
          ...(duration !== undefined && { durationMs: duration }),
          ...(incomplete && { traceIncomplete: true }),
        },
        checks,
      };
    } finally {
      // 5. Release: resettable resources unlock for the next row.
      await resolved.release?.().catch(err => {
        console.error("failed to release an eval row's resources:", err);
      });
    }
  }

  /** One check's verdict on one run. Never throws. */
  private async judge(
    check: EvalCheck,
    resolved: ResolvedPromptInputs,
    run: CheckRun,
  ): Promise<JudgedOutcome> {
    let prepared: PreparedCheck;
    try {
      prepared = await this.prepare(check, resolved);
    } catch (err: any) {
      // An input that fails validation is the check's `error` — the prompt
      // did nothing wrong. See `specs/evals.md` §B.2.
      return { outcome: "error", message: err?.message ?? String(err) };
    }
    if (run.status === "error" && !prepared.runsOnError) {
      return { outcome: "skipped", message: "The run failed" };
    }
    try {
      const value = await withTimeout(
        Promise.resolve().then(() => prepared.run(run)),
        prepared.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      );
      return outcomeFromReturn(value, check.threshold);
    } catch (err) {
      return outcomeFromError(err);
    }
  }

  /**
   * `check` ready to run in this run's lease — through the provider, which
   * resolves a playground check's resources from the lease, or here, for a
   * built-in on a provider that can't.
   */
  private async prepare(
    check: EvalCheck,
    resolved: ResolvedPromptInputs,
  ): Promise<PreparedCheck> {
    if (resolved.prepareCheck) {
      return resolved.prepareCheck(check.uri, check.args);
    }
    const target = builtinCheck(check.uri);
    if (!target) throw new Error(`Check '${check.uri}' not found`);
    const values = resolved.resolveMore
      ? await resolved.resolveMore(check.args)
      : {};
    const validated = await validateArguments(
      Object.entries(target.inputs ?? {}).filter(
        (entry): entry is [string, StandardSchemaV1] =>
          isStandardSchema(entry[1]),
      ),
      values,
      `Check '${target.label ?? check.uri}'`,
    );
    return {
      run: run => target.run(validated as never, run),
      timeoutMs: target.timeoutMs,
      runsOnError: target.runsOnError,
    };
  }

  /** How long to wait for a trace, and how often to look. */
  private traceWait(): { intervalMs: number; timeoutMs: number } {
    return this.options.traceWait ?? { intervalMs: 100, timeoutMs: 10_000 };
  }

  /**
   * Polls for `traceId` until it's complete (`specs/evals.md` §D.3). On
   * timeout, whatever arrived — flagged incomplete.
   */
  private async waitForTrace(
    traceId: string,
  ): Promise<{ trace: TraceWithSpans; incomplete: boolean }> {
    const { intervalMs, timeoutMs } = this.traceWait();
    const deadline = Date.now() + timeoutMs;
    let trace: TraceWithSpans | undefined;
    for (;;) {
      trace = await this.options.traceProvider.getTrace(traceId);
      if (isComplete(trace)) return { trace: trace!, incomplete: false };
      if (Date.now() >= deadline) break;
      await sleep(intervalMs);
    }
    return {
      trace: trace ?? {
        trace: {
          id: traceId,
          name: "",
          startTime: Date.now(),
          status: "running",
        },
        spans: [],
      },
      incomplete: true,
    };
  }
}

/** What every row of a run shares. */
interface RowContext {
  promptProvider: PromptProvider;
  prompt: NormalizedPrompt;
  dataset: Dataset;
  definition: EvalDefinition;
}

/** A row's results, ready to record. */
interface RowResults {
  row: EvalRowResult;
  checks: EvalCheckResult[];
}
