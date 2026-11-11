// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A `Set` of subscribers that says when it gains its first and loses its
 * last, so whatever feeds them runs only while someone's listening.
 */
export class SubscriberSet<T> extends Set<T> {
  private readonly hooks: { onFirst(): void; onEmpty(): void };

  constructor(hooks: { onFirst(): void; onEmpty(): void }) {
    super();
    this.hooks = hooks;
  }

  override add(value: T): this {
    const wasEmpty = this.size === 0;
    super.add(value);
    // `Set`'s constructor adds through here before `hooks` is assigned.
    if (wasEmpty && this.size > 0) this.hooks?.onFirst();
    return this;
  }

  override delete(value: T): boolean {
    const deleted = super.delete(value);
    if (deleted && this.size === 0) this.hooks.onEmpty();
    return deleted;
  }

  override clear(): void {
    const hadAny = this.size > 0;
    super.clear();
    if (hadAny) this.hooks.onEmpty();
  }
}
