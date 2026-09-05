// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Supporting types for `opaque-param.prompt.ts` and `odin.playground.ts`.
 *
 * Stands in for the motivating real case: a Drizzle `DrizzleD1Database`, which
 * is `declare class … extends BaseSQLiteDatabase` intersected with a `$client`
 * property. It has to be a class for the §A class rule to be what fires, and
 * an intersection for the rule to have to look through one.
 */
export declare class Database {
  /** Data, not behaviour — so the all-method rule would *not* fire here. */
  readonly url: string;
  private connection;
  query(sql: string): Promise<unknown[]>;
  insert(table: string): { values(row: unknown): Promise<void> };
}

/** A handle type shaped like the real one: a class inside an intersection. */
export type Db = Database & { $client: { name: string } };

/** A branded id, spelled as a template literal — the way the SDK infers them. */
export type TaskId = `tsk_${string}`;

/** A workspace id, likewise. */
export type WorkspaceId = `ws_${string}`;
