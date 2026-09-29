// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** Promises still pending, and a way to wait until there are none. */
export interface InFlight {
  /** How many tracked promises haven't settled yet. */
  readonly size: number;
  /** Tracks `promise` until it settles, and returns it. */
  track<T>(promise: Promise<T>): Promise<T>;
  /**
   * Resolves once nothing tracked is pending — including anything tracked
   * while waiting. Never rejects: a failure is its tracker's to report.
   */
  settled(): Promise<void>;
}

/** A fresh {@link InFlight}. */
export function createInFlight(): InFlight {
  const pending = new Set<Promise<unknown>>();
  return {
    get size() {
      return pending.size;
    },
    track(promise) {
      pending.add(promise);
      const done = () => pending.delete(promise);
      promise.then(done, done);
      return promise;
    },
    async settled() {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  };
}
