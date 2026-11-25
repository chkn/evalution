// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** How many times {@link transaction} runs a transaction before giving up. */
const MAX_ATTEMPTS = 5;

/**
 * Whether `err`, or an error it wraps as its `cause` (Drizzle wraps the
 * driver's error in a `DrizzleQueryError`), is Turso's "Database snapshot is
 * stale". The pinned `@tursodatabase/sync` reports it as a `GenericFailure`
 * with no code of its own, so the message is all there is to go on.
 */
export function isStaleSnapshotError(err: unknown): boolean {
  let current = err;
  for (let depth = 0; current instanceof Error && depth < 10; depth++) {
    if (/snapshot is stale/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * `db.transaction(fn)`, run again if it failed because its snapshot went
 * stale. Use it in place of `db.transaction` on a Turso-backed Drizzle
 * database. `db.transaction()` begins deferred, so a transaction that reads
 * before it writes holds only a read snapshot until its first write; if
 * another connection to the same file committed in between (the sync
 * engine applying a pull, the query worker's process, another process on the
 * same workspace), Turso refuses the write and asks for the whole transaction
 * to be retried. Drizzle has already rolled it back by the time the error
 * gets here, so running it again starts afresh on a new snapshot. (`BEGIN
 * IMMEDIATE` would only move the failure: the other writer then fails with
 * "database is locked" instead.)
 *
 * `fn` must be safe to run more than once: database work in `tx` only, with
 * no side effects outside it.
 */
export async function transaction<Tx, T>(
  db: { transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R> },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(fn);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isStaleSnapshotError(err)) throw err;
    }
  }
}
