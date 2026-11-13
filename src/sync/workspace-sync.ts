// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Syncing a linked project's local databases — traces, evals, and one per
 * dataset — with Evalution Cloud. See PLAN §6 in the cloud repo.
 */

import {
  type Evalution,
  EvalutionApiError,
  type SyncDatabaseKey,
} from "@evalution/sdk";
import { DatabaseSync } from "./database-sync.ts";

/** The cloud calls a {@link WorkspaceSync} makes. */
export type WorkspaceCloud = Pick<
  Evalution,
  "getSyncDatabase" | "listSyncDatabases" | "deleteSyncDatabase"
>;

/** Options for {@link WorkspaceSync}. */
export interface WorkspaceSyncOptions {
  cloud: WorkspaceCloud;
  /** How often to pull while running, in ms. */
  pullIntervalMs?: number;
  /** Checkpoint every this many pulls. */
  checkpointEvery?: number;
  /** How long closing may take to push what's left, in ms. */
  closeTimeoutMs?: number;
  log?: Pick<Console, "warn">;
}

/** Often enough that another machine's work shows up while you look. */
const DEFAULT_PULL_INTERVAL_MS = 30_000;

/** Every five minutes, at the default interval. */
const DEFAULT_CHECKPOINT_EVERY = 10;

const DEFAULT_CLOSE_TIMEOUT_MS = 3000;

function keyOf({ kind, provider, key = "" }: SyncDatabaseKey): string {
  return JSON.stringify([kind, provider, key]);
}

/**
 * A provider that syncs once given the project's {@link WorkspaceSync}: the
 * local trace, eval and dataset providers. Not public API yet.
 */
export interface SyncingProvider {
  /** Names its databases in the cloud: every machine's config agrees on it. */
  readonly id: string;
  _ecSetSync(sync: WorkspaceSync): void;
}

function canSync(provider: unknown): provider is SyncingProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    typeof (provider as Partial<SyncingProvider>)._ecSetSync === "function" &&
    typeof (provider as Partial<SyncingProvider>).id === "string"
  );
}

/** A project's providers, by kind, for {@link WorkspaceSync.syncProviders}. */
export interface ProvidersToSync {
  traces: readonly unknown[];
  datasets: readonly unknown[];
  evals: readonly unknown[];
}

const KIND_NAMES: Record<keyof ProvidersToSync, string> = {
  traces: "trace",
  datasets: "dataset",
  evals: "eval",
};

/**
 * The project's synced databases. Each local provider, given this by
 * `syncProviders`, asks it for the {@link DatabaseSync} of each of its
 * databases; this pulls them all on an interval and when the playground asks
 * ({@link pullAll}, when its window regains focus).
 */
export class WorkspaceSync {
  private readonly cloud: WorkspaceCloud;
  private readonly pullIntervalMs: number;
  private readonly checkpointEvery: number;
  private readonly closeTimeoutMs: number;
  private readonly log: Pick<Console, "warn">;
  private readonly databases = new Map<string, DatabaseSync>();
  private readonly hooks = new Set<() => Promise<void>>();
  private readonly statusListeners = new Set<() => void>();
  private pulling: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticks = 0;

  constructor(options: WorkspaceSyncOptions) {
    this.cloud = options.cloud;
    this.pullIntervalMs = options.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.checkpointEvery = options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.log = options.log ?? console;
  }

  /**
   * Gives each provider that can sync this, whether the config made it or
   * the defaults did: it syncs its own databases, named by its id. Of a
   * kind's providers that share an id, only the first syncs, since they'd
   * share databases.
   *
   * @internal Not public API yet, like `_ecSetSync`.
   */
  syncProviders(providers: ProvidersToSync): void {
    const given = new Set<SyncingProvider>();
    for (const kind of Object.keys(KIND_NAMES) as (keyof ProvidersToSync)[]) {
      const ids = new Set<string>();
      for (const provider of providers[kind]) {
        if (!canSync(provider) || given.has(provider)) continue;
        if (ids.has(provider.id)) {
          this.log.warn(
            `⚠️ Two ${KIND_NAMES[kind]} providers have the id "${provider.id}"; only the first syncs. Give each its own id.`,
          );
          continue;
        }
        ids.add(provider.id);
        given.add(provider);
        provider._ecSetSync(this);
      }
    }
  }

  /** The sync for one database, made on first ask. */
  database(key: SyncDatabaseKey, schemaVersion: number): DatabaseSync {
    const id = keyOf(key);
    let sync = this.databases.get(id);
    if (!sync) {
      sync = new DatabaseSync({
        cloud: this.cloud,
        key,
        schemaVersion,
        onStatusChange: () => {
          for (const listener of this.statusListeners) listener();
        },
        log: this.log,
      });
      this.databases.set(id, sync);
    }
    return sync;
  }

  /**
   * The databases being adopted (see `local-database.ts`): their providers'
   * operations wait while each copy takes its file's place.
   */
  adopting(): SyncDatabaseKey[] {
    return Array.from(this.databases.values())
      .filter(db => db.isAdopting)
      .map(db => db.key);
  }

  /** Runs `listener` whenever {@link adopting} changes. */
  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Runs `hook` after each {@link pullAll}: how new datasets are found. */
  onPull(hook: () => Promise<void>): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** Starts pulling on an interval. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.ticks++;
      void this.pullAll().then(async () => {
        if (this.ticks % this.checkpointEvery === 0) {
          await Promise.all(
            Array.from(this.databases.values(), db => db.checkpoint()),
          );
        }
      });
    }, this.pullIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Pulls every database now, sharing a pull that's already under way. A
   * database being adopted is pulled (and so pushed) once it's adopted.
   * Never rejects.
   */
  pullAll(): Promise<void> {
    this.pulling ??= (async () => {
      try {
        await Promise.all(
          Array.from(this.databases.values(), async db => {
            await db.pull();
            if (!db.isAdopting) return;
            await db.adopted();
            await db.pull();
          }),
        );
        for (const hook of this.hooks) {
          await hook().catch(err =>
            this.log.warn(`⚠️ Sync failed: ${(err as Error).message}`),
          );
        }
      } finally {
        this.pulling = undefined;
      }
    })();
    return this.pulling;
  }

  /**
   * The ids of a dataset provider's datasets in the cloud, or `undefined` if
   * it can't be asked.
   */
  async remoteDatasetIds(provider: string): Promise<string[] | undefined> {
    try {
      const all = await this.cloud.listSyncDatabases();
      return all
        .filter(db => db.kind === "dataset" && db.provider === provider)
        .map(db => db.key);
    } catch {
      return undefined;
    }
  }

  /**
   * Stops syncing a provider's dataset, and forgets its sync, so a dataset
   * made again with its id starts afresh. For one deleted on another machine.
   */
  async forgetDataset(provider: string, datasetId: string): Promise<void> {
    const id = keyOf({ kind: "dataset", provider, key: datasetId });
    const sync = this.databases.get(id);
    this.databases.delete(id);
    await sync?.close();
  }

  /**
   * Deletes a provider's dataset from the cloud. Every other machine whose
   * copy synced with it removes it on its next pull. Never rejects.
   */
  async deleteDataset(provider: string, datasetId: string): Promise<void> {
    await this.forgetDataset(provider, datasetId);
    const key = { kind: "dataset", provider, key: datasetId } as const;
    try {
      await this.cloud.deleteSyncDatabase(key);
    } catch (err) {
      // Never synced, or already deleted on another machine.
      if (err instanceof EvalutionApiError && err.status === 404) return;
      this.log.warn(
        `⚠️ Couldn't delete the dataset ${datasetId} from Evalution Cloud (${(err as Error).message}).`,
      );
    }
  }

  /** Stops pulling, and pushes what's left, waiting a few seconds at most. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.race([
      Promise.all(Array.from(this.databases.values(), db => db.close())),
      new Promise(resolve =>
        setTimeout(resolve, this.closeTimeoutMs).unref?.(),
      ),
    ]);
  }
}
