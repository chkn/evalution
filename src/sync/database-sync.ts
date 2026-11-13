// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Keeps one local database file in sync with its copy in Evalution Cloud
 * (PLAN §6 in the cloud repo): asks the cloud where the copy is and for a
 * token, then pushes after writes and pulls when asked. Nothing here can stop
 * the playground working: until the cloud answers, and for good if it says
 * no, the database is just local.
 *
 * A file syncs only once it holds the cloud database's rows: see
 * `local-database.ts` for how a file that doesn't is adopted.
 */

import {
  type Evalution,
  EvalutionApiError,
  type SyncDatabaseCredentials,
  type SyncDatabaseKey,
} from "@evalution/sdk";

/** The cloud call a {@link DatabaseSync} makes. */
export type SyncCloud = Pick<Evalution, "getSyncDatabase">;

/** The sync operations of a `@tursodatabase/sync` database. */
export interface SyncedDatabase {
  push(): Promise<unknown>;
  pull(): Promise<boolean>;
  checkpoint(): Promise<unknown>;
}

/** Options for {@link DatabaseSync}. */
export interface DatabaseSyncOptions {
  cloud: SyncCloud;
  /** Which of the project's synced databases this is. */
  key: SyncDatabaseKey;
  /** The local schema's version: see `TRACE_SCHEMA_VERSION`. */
  schemaVersion: number;
  /** How long after the last write to push, in ms. */
  pushDelayMs?: number;
  /** How long opening the database waits on the cloud, in ms. */
  prepareTimeoutMs?: number;
  /** Runs when {@link DatabaseSync.isAdopting} changes. */
  onStatusChange?: () => void;
  log?: Pick<Console, "warn">;
}

/** What {@link DatabaseSync.attach} needs to know about the open file. */
export interface AttachOptions {
  /** The sync ids of the cloud databases the file has synced with. */
  links: readonly string[];
  /** Runs whenever a pull brings changes. */
  onPulled: () => void;
  /**
   * Makes the file a copy of the cloud's database that holds its rows too,
   * then attaches that. Called when the cloud names a database the file has
   * no link to.
   */
  adopt: () => Promise<void>;
}

/** Writes come in bursts (a span start, then its end): push once they settle. */
const DEFAULT_PUSH_DELAY_MS = 1000;

/** As long as `evalution` waits on the cloud before opening the browser. */
const DEFAULT_PREPARE_TIMEOUT_MS = 2000;

/** How long before a token expires to get a new one. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Answers that retrying won't change. */
const PERMANENT_STATUSES = new Set([401, 403, 404, 409, 410]);

function describe(key: SyncDatabaseKey): string {
  switch (key.kind) {
    case "traces":
      return "the trace database";
    case "evals":
      return "the eval database";
    case "dataset":
      return `the dataset ${key.key}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref?.());
}

/**
 * One local database's link to its cloud copy. Hand {@link getCloudUrl} and
 * {@link getAuthToken} to `createLocalTursoClient`, after {@link prepare} so
 * a database that isn't on this machine yet starts from the cloud's copy.
 * Then {@link attach} the open database.
 */
export class DatabaseSync {
  private readonly cloud: SyncCloud;
  private readonly schemaVersion: number;
  private readonly pushDelayMs: number;
  private readonly prepareTimeoutMs: number;
  private readonly onStatusChange: () => void;
  private readonly log: Pick<Console, "warn">;
  /** What this database is, in messages. */
  readonly label: string;
  /** Which of the project's synced databases this is. */
  readonly key: SyncDatabaseKey;

  private credentials: SyncDatabaseCredentials | undefined;
  private requesting: Promise<SyncDatabaseCredentials | undefined> | undefined;
  private stopped = false;
  private closed = false;
  private create = false;

  private db: SyncedDatabase | undefined;
  private onPulled: () => void = () => {};
  /** The open file's links: see {@link AttachOptions.links}. */
  private links: ReadonlySet<string> = new Set();
  /** A file new to this machine is being made from the cloud's copy. */
  private bootstrapping = false;
  private adoptFile: (() => Promise<void>) | undefined;
  private adopting: Promise<void> | undefined;
  /** Local writes may not have been pushed. */
  private owesPush = false;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  /** The operation in flight: the engine runs one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private warned = false;

  constructor(options: DatabaseSyncOptions) {
    this.cloud = options.cloud;
    this.key = options.key;
    this.schemaVersion = options.schemaVersion;
    this.pushDelayMs = options.pushDelayMs ?? DEFAULT_PUSH_DELAY_MS;
    this.prepareTimeoutMs =
      options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
    this.onStatusChange = options.onStatusChange ?? (() => {});
    this.log = options.log ?? console;
    this.label = describe(options.key);
  }

  /** Whether the cloud has answered, and not said no. */
  get isAvailable(): boolean {
    return !!this.credentials && !this.stopped;
  }

  /** The cloud's answer, while it stands. */
  get currentCredentials(): SyncDatabaseCredentials | undefined {
    return this.stopped ? undefined : this.credentials;
  }

  /** Whether the open file holds the rows of the database the cloud names. */
  get isLinked(): boolean {
    const credentials = this.currentCredentials;
    return !!credentials && this.links.has(credentials.syncId);
  }

  /**
   * Whether the file is being adopted. Its provider's operations wait while
   * the copy takes its place, so this is shown.
   */
  get isAdopting(): boolean {
    return this.adopting !== undefined;
  }

  /** Whether the cloud has said this database can't sync, so it never will this session. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Asks the cloud where the database is, waiting a little for the answer.
   * Never rejects: without an answer the database opens local-only and
   * switches sync on once one comes. `create` is for a dataset being made
   * now, whose id may be a deleted one's.
   */
  async prepare({ create = false }: { create?: boolean } = {}): Promise<void> {
    if (this.credentials || this.stopped) return;
    this.create = create;
    await Promise.race([
      this.requestCredentials(),
      sleep(this.prepareTimeoutMs),
    ]);
  }

  /**
   * The cloud copy's URL once the file holds its rows; `null` keeps the
   * database local. Pulling into a file that doesn't would drop its rows.
   */
  readonly getCloudUrl = (): string | null => {
    const credentials = this.currentCredentials;
    if (!credentials) return null;
    return this.bootstrapping || this.links.has(credentials.syncId)
      ? credentials.url
      : null;
  };

  /**
   * Says the file is about to be made, so it should start as a copy of the
   * cloud's: {@link getCloudUrl} answers while connecting.
   */
  beginBootstrap(): void {
    this.bootstrapping = this.isAvailable;
  }

  /** After connecting: the cloud database the new file is a copy of, if it is one. */
  endBootstrap(): SyncDatabaseCredentials | undefined {
    const copied = this.bootstrapping ? this.currentCredentials : undefined;
    this.bootstrapping = false;
    return copied;
  }

  /** A current token for the cloud copy. Only called by the engine once {@link getCloudUrl} has a URL. */
  readonly getAuthToken = async (): Promise<string> => {
    const current = this.credentials;
    if (current && current.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return current.token;
    }
    const fresh = await this.requestCredentials();
    if (!fresh) throw new Error(`Evalution Cloud didn't sync ${this.label}`);
    return fresh.token;
  };

  /** For `createLocalTursoClient`'s `onBootstrapFailure`. */
  readonly reportBootstrapFailure = (err: unknown): void => {
    // The file is made empty instead, and adopted once the cloud answers.
    this.bootstrapping = false;
    this.warnOnce(
      `⚠️ Couldn't fetch ${this.label} from Evalution Cloud (${(err as Error).message}); it starts empty here until the next sync.`,
    );
  };

  /** Asks the cloud for credentials, sharing a request already in flight. */
  private requestCredentials(): Promise<SyncDatabaseCredentials | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    this.requesting ??= (async () => {
      try {
        const credentials = await this.cloud.getSyncDatabase({
          ...this.key,
          schemaVersion: this.schemaVersion,
          ...(this.create && { create: true }),
        });
        if (!this.credentials) this.owesPush = true;
        this.credentials = credentials;
        // Made now: asking again would bring it back if it's deleted.
        this.create = false;
        this.warned = false;
        void this.adoptIfUnlinked();
        return credentials;
      } catch (err) {
        this.reportCredentialsFailure(err);
        return undefined;
      } finally {
        this.requesting = undefined;
      }
    })();
    return this.requesting;
  }

  private reportCredentialsFailure(err: unknown): void {
    const status = err instanceof EvalutionApiError ? err.status : undefined;
    if (status === undefined || !PERMANENT_STATUSES.has(status)) {
      this.warnOnce(
        `⚠️ Couldn't reach Evalution Cloud to sync ${this.label} (${(err as Error).message}); retrying.`,
      );
      return;
    }
    this.stopped = true;
    this.credentials = undefined;
    const detail = (err as EvalutionApiError).detail;
    const reason =
      status === 404
        ? "your EVALUTION_API_KEY cannot access the project linked from .evalution/config.ts"
        : status === 401 || status === 403
          ? "Evalution Cloud didn't accept EVALUTION_API_KEY"
          : status === 410
            ? `it was deleted from the project${detail ? ` (${detail})` : ""}`
            : (detail ?? `the cloud answered ${status}`);
    this.log.warn(
      `⚠️ Not syncing ${this.label}: ${reason}. It stays on this machine.`,
    );
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log.warn(message);
  }

  /**
   * Starts syncing the open database: pulls what the cloud has, then pushes
   * what this machine has. A file with no link to the cloud's database is
   * adopted instead, once the cloud answers. Attaching the database that's
   * attached already does nothing.
   */
  attach(db: SyncedDatabase, { links, onPulled, adopt }: AttachOptions): void {
    if (this.db === db) return;
    this.db = db;
    this.links = new Set(links);
    this.onPulled = onPulled;
    this.adoptFile = adopt;
    this.owesPush = true;
    if (this.isLinked) void this.pull();
    else void this.adoptIfUnlinked();
  }

  /** Settles once no adoption is under way. */
  async adopted(): Promise<void> {
    await this.adopting;
  }

  /** Adopts the file if the cloud names a database it has no link to. Never rejects. */
  private adoptIfUnlinked(): Promise<void> {
    if (this.adopting) return this.adopting;
    const adopt = this.adoptFile;
    if (!adopt || !this.db || this.closed || !this.isAvailable) {
      return Promise.resolve();
    }
    if (this.isLinked) return Promise.resolve();
    this.adopting = (async () => {
      try {
        await adopt();
      } catch (err) {
        this.warnOnce(
          `⚠️ Couldn't start syncing ${this.label} with Evalution Cloud (${(err as Error).message}); retrying.`,
        );
      } finally {
        this.adopting = undefined;
        this.onStatusChange();
      }
    })();
    this.onStatusChange();
    return this.adopting;
  }

  /** Says the database was written to: it's pushed once writes settle. */
  noteWrite(): void {
    if (!this.db || this.closed || this.stopped) return;
    this.owesPush = true;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.run(() => this.pushIfOwed());
    }, this.pushDelayMs);
    this.pushTimer.unref?.();
  }

  /**
   * Pulls the cloud's changes, and pushes this machine's if it has any.
   * `true` if the pull brought changes. Never rejects.
   */
  async pull(): Promise<boolean> {
    if (!this.db || this.closed || this.stopped) return false;
    if (!this.credentials && !(await this.requestCredentials())) return false;
    if (!this.isLinked) {
      // Not awaited: a provider's operation may be the one pulling, and an
      // adoption waits for its operations.
      void this.adoptIfUnlinked();
      return false;
    }
    return this.run(async () => {
      const db = this.db;
      if (!db) return false;
      const changed = await db.pull();
      await this.pushIfOwed();
      if (changed) this.onPulled();
      return changed;
    });
  }

  /** Folds the database's write-ahead log into it. Never rejects. */
  async checkpoint(): Promise<void> {
    // An adoption closes the file.
    if (!this.db || this.closed || this.adopting) return;
    await this.run(async () => {
      await this.db?.checkpoint();
      return undefined;
    });
  }

  private async pushIfOwed(): Promise<undefined> {
    if (!this.owesPush || !this.db || !this.getCloudUrl()) return undefined;
    this.owesPush = false;
    try {
      await this.db.push();
    } catch (err) {
      this.owesPush = true;
      throw err;
    }
    return undefined;
  }

  /** Runs `op` after whatever is in flight, reporting a failure rather than rejecting. */
  private run<T>(op: () => Promise<T>): Promise<T | false> {
    const result = this.chain.then(async () => {
      try {
        const value = await op();
        this.warned = false;
        return value;
      } catch (err) {
        this.warnOnce(
          `⚠️ Couldn't sync ${this.label} with Evalution Cloud (${(err as Error).message}); retrying.`,
        );
        return false as const;
      }
    });
    this.chain = result;
    return result;
  }

  /** Settles once no operation is in flight. */
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }

  /** Pushes what hasn't been, then stops syncing. */
  async close(): Promise<void> {
    if (this.closed) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
    await this.adopting;
    if (this.db && !this.stopped) await this.run(() => this.pushIfOwed());
    this.closed = true;
    await this.idle();
  }
}
