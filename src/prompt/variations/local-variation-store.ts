// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Node-side (fs-allowed) bootstrap for the local {@link TursoVariationStore}
 * — the one place a real path gets involved, as `local-turso-client.ts` is
 * for traces.
 */

import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type { VariationId, VersionId } from "../../shared/types.ts";
import {
  assertSqliteFile,
  createLocalTursoClient,
} from "../../trace/db/local-turso-client.ts";
import { mkdirSelfIgnoring } from "../../trace/db/self-ignoring-dir.ts";
import { runVariationMigrations } from "./db/migrate.ts";
import { TursoVariationStore } from "./turso-variation-store.ts";
import type {
  NewWip,
  VariationContent,
  VariationStore,
  WipChanges,
} from "./variation-store.ts";

/**
 * Opens (creating if needed) the variation database at `path` — by default
 * `.evalution/variations/variations.db` — in a directory that ignores itself,
 * so variations stay out of git without anyone editing their `.gitignore`.
 */
export async function openLocalVariationStore(
  path: string,
): Promise<TursoVariationStore> {
  await mkdirSelfIgnoring(dirname(path));
  await assertSqliteFile(path);
  const client = await createLocalTursoClient({ path });
  await runVariationMigrations(drizzle({ client }));
  return new TursoVariationStore({ client });
}

/**
 * The default variation store: a {@link TursoVariationStore} at `path` that
 * isn't created until something is written. Until then every read answers
 * "nothing" — so browsing prompts never leaves a database behind, just as
 * the trace store writes nothing until the first trace.
 */
export class LocalVariationStore implements VariationStore {
  private readonly path: string;
  private opened?: Promise<TursoVariationStore>;

  /** @param path - The database file; created, with its directory, on first write. */
  constructor(path: string) {
    this.path = path;
  }

  /** Whether a failure to open has been reported, so it's reported once. */
  private warned = false;

  /** The store, creating it if needed. Set synchronously, so concurrent first writes share one open. */
  private open(): Promise<TursoVariationStore> {
    this.opened ??= openLocalVariationStore(this.path).catch(err => {
      throw new Error(
        /lock/i.test(String(err?.message))
          ? `The variation store at ${this.path} is in use by another evalution process; unsaved edits are unavailable in this one.`
          : `Couldn't open the variation store at ${this.path}: ${err?.message ?? err}`,
      );
    });
    // A failed open may succeed later (the directory was read-only, say).
    this.opened.catch(() => {
      this.opened = undefined;
    });
    return this.opened;
  }

  /**
   * The store if it exists yet, without creating it. A store that won't open
   * — locked by another evalution process on the same project, say — reads
   * as empty, with a warning, rather than failing every prompt read (and
   * with them, startup).
   */
  private async existing(): Promise<TursoVariationStore | undefined> {
    const exists =
      !!this.opened ||
      (await access(this.path).then(
        () => true,
        () => false,
      ));
    if (!exists) return undefined;
    try {
      return await this.open();
    } catch (err: any) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`⚠️ ${err?.message ?? err}`);
      }
      return undefined;
    }
  }

  async get(id: VariationId) {
    return (await this.existing())?.get(id);
  }
  async intern(v: VariationContent) {
    return (await this.open()).intern(v);
  }
  async getWip(promptId: string, base: VersionId) {
    return (await this.existing())?.getWip(promptId, base);
  }
  async getHeadWip(promptId: string) {
    return (await this.existing())?.getHeadWip(promptId);
  }
  async listHeadWips() {
    return (await (await this.existing())?.listHeadWips()) ?? [];
  }
  async putWip(v: NewWip) {
    return (await this.open()).putWip(v);
  }
  async updateWip(id: VariationId, changes: WipChanges) {
    return (await this.open()).updateWip(id, changes);
  }
  async deleteWip(id: VariationId) {
    await (await this.existing())?.deleteWip(id);
  }
  async list(promptId: string) {
    return (await (await this.existing())?.list(promptId)) ?? [];
  }
  async name(id: VariationId, promptId: string, name: string) {
    await (await this.open()).name(id, promptId, name);
  }
  async unname(promptId: string, name: string) {
    await (await this.existing())?.unname(promptId, name);
  }
}
