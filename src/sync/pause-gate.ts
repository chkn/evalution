// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Lets a provider's operations on its database run side by side, except
 * while the database is swapped for another file: {@link pause} waits for
 * the operations under way, and holds new ones until it's done.
 *
 * An operation must not start another one and wait for it — while a pause
 * waits on the first, the second would wait on the pause.
 */
export class PauseGate {
  private running = 0;
  private paused: Promise<void> | undefined;
  private onIdle: (() => void) | undefined;

  /** Whether a pause is waiting or under way. */
  get isPaused(): boolean {
    return this.paused !== undefined;
  }

  /** Runs `op`, after any pause. */
  async run<T>(op: () => Promise<T>): Promise<T> {
    while (this.paused) await this.paused;
    this.running++;
    try {
      return await op();
    } finally {
      if (--this.running === 0) this.onIdle?.();
    }
  }

  /** Runs `during` once no operation is under way, holding new ones until it settles. */
  async pause<T>(during: () => Promise<T>): Promise<T> {
    while (this.paused) await this.paused;
    let resume: () => void = () => {};
    this.paused = new Promise(resolve => {
      resume = resolve;
    });
    try {
      if (this.running > 0) {
        await new Promise<void>(resolve => {
          this.onIdle = resolve;
        });
      }
      return await during();
    } finally {
      this.onIdle = undefined;
      this.paused = undefined;
      resume();
    }
  }
}
