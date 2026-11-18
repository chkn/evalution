// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  type Evalution,
  filterTraces,
  groupTraceSummaries,
  isEmptyTraceQuery,
  type TraceChangeEvent,
  type TraceGroup,
  type TraceGroupQuery,
  type TraceQuery,
  type TraceSummary,
  type TraceWithSpans,
} from "@evalution/sdk";
import type { TraceProvider } from "./trace-provider.ts";

/** How far back {@link CloudTraceProvider} lists traces by default: a week. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How many traces {@link CloudTraceProvider} lists by default. */
const DEFAULT_LIMIT = 200;

/** How often {@link CloudTraceProvider} checks for new traces while watched. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** The least often {@link CloudTraceProvider} checks while nothing changes. */
const DEFAULT_MAX_POLL_INTERVAL_MS = 5 * 60_000;

/** The calls {@link CloudTraceProvider} makes of the cloud. */
export type CloudTraceClient = Pick<
  Evalution,
  "listTraces" | "getTrace" | "listTraceGroups"
>;

/** Options for {@link CloudTraceProvider}. */
export interface CloudTraceProviderOptions {
  /**
   * The cloud client, with a personal key and the project to read: what
   * `evalution` builds from `EVALUTION_API_KEY` and the config's
   * `cloud.project`.
   */
  client: CloudTraceClient;
  /** Defaults to `"cloud"`. */
  id?: string;
  displayName?: string;
  description?: string;
  /** Only traces from this deployment environment. Defaults to all of them. */
  environment?: string;
  /** How many of the most recent traces to list. Defaults to 200. */
  limit?: number;
  /** How far back to list traces, in ms. Defaults to a week. */
  windowMs?: number;
  /**
   * How often to check for new and changed traces while watched, in ms.
   * Defaults to 15s.
   */
  pollIntervalMs?: number;
  /**
   * The longest to wait between checks, in ms: each check that finds nothing
   * new doubles the wait, up to this. Defaults to 5 minutes.
   */
  maxPollIntervalMs?: number;
  /** Where to report a cloud that can't be reached. Defaults to `console`. */
  log?: Pick<Console, "warn">;
}

/** What the cloud's traces have: it keeps no annotations. */
const NO_ANNOTATIONS = { issue: 0, good: 0, note: 0 };

/** What a summary shows that can change, so a poll can tell it changed. */
function fingerprint(trace: TraceSummary): string {
  return [
    trace.status,
    trace.endTime,
    trace.spanCount,
    trace.totalTokens,
    trace.cost,
  ].join("|");
}

/**
 * The project's production traces, read from Evalution Cloud: what the apps
 * you deployed sent with an ingest key. Read-only. There's no live stream of
 * a trace's spans, and no annotations or SQL; {@link watch} polls the cloud
 * for new and changed traces instead, less often while nothing changes and
 * nobody lists the traces, since each poll is a query the cloud pays for.
 *
 * `evalution` adds one of these next to the configured trace providers when
 * `EVALUTION_API_KEY` is a personal key and `.evalution/config.ts` links a
 * project.
 *
 * It lists the most recent traces within a window (see
 * {@link CloudTraceProviderOptions}), since {@link TraceProvider.getAllTraces}
 * doesn't page. A search, filters and grouping run in the cloud, so they
 * reach every trace in the window, not only the most recent ones. A cloud
 * that can't be reached never fails the listing: the last traces it returned
 * are shown instead, and the failure is reported once.
 */
export class CloudTraceProvider implements TraceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;

  private readonly client: CloudTraceClient;
  private readonly environment?: string;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly log: Pick<Console, "warn">;

  private watchers = new Set<(event: TraceChangeEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** How long the next poll waits after the one before it, in ms. */
  private delayMs = 0;
  /** When the next poll is due, in ms since the epoch. */
  private dueAt = 0;
  /** Whether a poll is waiting on the cloud. */
  private polling = false;
  /** What the last listing returned, by id, as {@link fingerprint}s. */
  private known: Map<string, string> | undefined;
  private lastListed: TraceSummary[] = [];
  private failing = false;

  constructor(options: CloudTraceProviderOptions) {
    this.client = options.client;
    this.id = options.id ?? "cloud";
    this.displayName = options.displayName ?? "Production";
    this.description =
      options.description ??
      "Traces your deployed apps sent to Evalution Cloud.";
    this.environment = options.environment;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollIntervalMs = Math.max(
      this.pollIntervalMs,
      options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
    );
    this.log = options.log ?? console;
  }

  async getAllTraces(query?: TraceQuery): Promise<TraceSummary[]> {
    this.hurry();
    try {
      return await this.list(query);
    } catch {
      // The server filters what a provider returns, so the last full listing
      // still answers a query, as far as it reaches.
      return this.lastListed;
    }
  }

  /**
   * The groups of every trace in the window that `query` matches, counted in
   * the cloud. When it can't be reached, the last traces it listed are
   * grouped instead.
   */
  async groupTraces(query: TraceGroupQuery): Promise<TraceGroup[]> {
    this.hurry();
    try {
      const groups = await this.client.listTraceGroups({
        ...this.window(),
        search: query.search,
        filters: query.filters,
        groupBy: query.groupBy,
        timeZone: query.timeZone,
      });
      this.failing = false;
      return groups.map(group => ({
        ...group,
        summary: {
          ...group.summary,
          annotationCounts: group.summary.annotationCounts ?? NO_ANNOTATIONS,
        },
      }));
    } catch (error) {
      this.reportFailure(error);
      return groupTraceSummaries(
        filterTraces(this.lastListed, query),
        query.groupBy,
        query.timeZone,
      );
    }
  }

  async getTrace(traceId: string): Promise<TraceWithSpans | undefined> {
    const found = await this.client.getTrace(traceId);
    if (!found) return undefined;
    return { ...found, trace: { ...found.trace, providerId: this.id } };
  }

  /**
   * Polls the cloud while anyone is watching. Each new trace is an `add`,
   * each changed one an `update`, and one that's left the window a `remove`.
   */
  watch(callback: (event: TraceChangeEvent) => void): () => void {
    this.watchers.add(callback);
    if (this.watchers.size === 1) {
      this.delayMs = this.pollIntervalMs;
      this.schedule(0);
    }
    return () => {
      this.watchers.delete(callback);
      if (this.watchers.size === 0) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.known = undefined;
      }
    };
  }

  /** The traces every listing is of: the environment's, in the window. */
  private window() {
    return {
      ...(this.environment && { environment: this.environment }),
      from: Date.now() - this.windowMs,
    };
  }

  private reportFailure(error: unknown): void {
    if (this.failing) return;
    this.log.warn(
      `⚠️ Couldn't list production traces from Evalution Cloud (${(error as Error).message}).`,
    );
    this.failing = true;
  }

  /**
   * Lists the traces `query` matches. A listing of them all also notes what
   * changed since the last one.
   */
  private async list(query?: TraceQuery): Promise<TraceSummary[]> {
    const everything = isEmptyTraceQuery(query);
    let listed: TraceSummary[];
    try {
      listed = await this.client.listTraces({
        ...this.window(),
        limit: this.limit,
        ...(!everything && { search: query?.search, filters: query?.filters }),
      });
    } catch (error) {
      this.reportFailure(error);
      throw error;
    }
    this.failing = false;
    const traces = listed.map(trace => ({
      ...trace,
      providerId: this.id,
      annotationCounts: trace.annotationCounts ?? NO_ANNOTATIONS,
    }));
    if (everything) {
      this.lastListed = traces;
      this.noteChanges(traces);
    }
    return traces;
  }

  private noteChanges(traces: TraceSummary[]): void {
    const previous = this.known;
    const current = new Map(traces.map(t => [t.id, fingerprint(t)]));
    // Only while watched, and not on the first listing, which is what a
    // watcher starts from rather than news.
    if (this.watchers.size > 0) this.known = current;
    if (!previous || this.watchers.size === 0) return;
    const events: TraceChangeEvent[] = [];
    for (const [traceId, print] of current) {
      const before = previous.get(traceId);
      if (before === undefined) events.push({ type: "add", traceId });
      else if (before !== print) events.push({ type: "update", traceId });
    }
    for (const traceId of previous.keys()) {
      if (!current.has(traceId)) events.push({ type: "remove", traceId });
    }
    // Something changing is a sign more will: look again soon.
    if (events.length > 0) this.delayMs = this.pollIntervalMs;
    for (const event of events) this.emit(event);
  }

  /**
   * Someone is looking at the traces: polls at the shortest interval again,
   * bringing the next poll forward if it's further off than that.
   */
  private hurry(): void {
    this.delayMs = this.pollIntervalMs;
    // A poll under way schedules the next one itself, with the delay above.
    if (this.timer === undefined || this.polling) return;
    if (this.dueAt - Date.now() <= this.pollIntervalMs) return;
    clearTimeout(this.timer);
    this.schedule(this.pollIntervalMs);
  }

  private schedule(delayMs: number): void {
    this.dueAt = Date.now() + delayMs;
    const timer = setTimeout(async () => {
      this.polling = true;
      try {
        await this.list().catch(() => {});
      } finally {
        this.polling = false;
      }
      // Unless the watchers left, or came back and started polling afresh.
      if (this.timer !== timer || this.watchers.size === 0) return;
      // The poll set `delayMs` back if it found a change.
      const wait = this.delayMs;
      this.delayMs = Math.min(wait * 2, this.maxPollIntervalMs);
      this.schedule(wait);
    }, delayMs);
    this.timer = timer;
    // Polling alone never keeps the process alive.
    (timer as { unref?: () => void }).unref?.();
  }

  private emit(event: TraceChangeEvent): void {
    for (const watcher of this.watchers) {
      try {
        watcher(event);
      } catch (error) {
        console.error("Trace watcher threw:", error);
      }
    }
  }
}
