// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * {@link VariationStore} backed by a Turso/libSQL database. fs-free: takes a
 * connected client, never a path — `openLocalVariationStore` is the Node-side
 * bootstrap. See `specs/prompt-versions-and-variations.md` §E.
 */

import type { Database } from "@tursodatabase/sync";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type {
  NormalizedPromptUpdates,
  PendingConflicts,
  VariationId,
  VersionId,
} from "../../shared/types.ts";
import type { FileSnapshotRecord } from "../versioning/file-snapshot-versioning.ts";
import { serializeUpdates } from "./canonical-updates.ts";
import {
  blobs,
  fileSnapshots,
  variationNames,
  variations,
} from "./db/schema.ts";
import type {
  NewWip,
  StoredVariation,
  VariationContent,
  VariationStore,
  WipChanges,
} from "./variation-store.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `var_` + 16 base-62 characters. */
function mintVariationId(): VariationId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = "var_";
  for (const b of bytes) id += BASE62[b % 62];
  return id;
}

/** Hex SHA-256 of `content`'s UTF-8 bytes. */
export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

type Row = typeof variations.$inferSelect;

/**
 * `VariationStore` over a Turso/libSQL database via
 * `drizzle-orm/tursodatabase-sync`. Migrations are *not* run here: call
 * `runVariationMigrations` against the same client first.
 */
export class TursoVariationStore implements VariationStore {
  private readonly db: ReturnType<
    typeof drizzle<Record<string, never>, Database>
  >;

  /** Tail of the serialized-write chain — as `TursoTraceProvider.serializeWrite`. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor({ client }: { client: Database }) {
    this.db = drizzle({ client });
  }

  /**
   * Runs an operation to completion before the next one starts: the client is
   * a single connection, and overlapping transactions on it fail outright —
   * as does a read that lands in the middle of one ("statement has been
   * finalized"). Reads go through here too; this store is small and quiet.
   */
  private serialize<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => {});
    return next;
  }

  /** Rows as {@link StoredVariation}s, with their names attached. */
  private async hydrate(rows: Row[]): Promise<StoredVariation[]> {
    if (rows.length === 0) return [];
    const names = await this.db
      .select()
      .from(variationNames)
      .where(
        inArray(
          variationNames.variationId,
          rows.map(r => r.id),
        ),
      )
      .orderBy(asc(variationNames.createdAt));
    return rows.map(row => ({
      id: row.id,
      promptId: row.promptId,
      ...(row.globalId && { globalId: row.globalId }),
      base: row.baseVersion,
      updates: JSON.parse(row.updates) as NormalizedPromptUpdates,
      wip: row.wip === 1,
      ...(row.wip === 1 && { onHead: row.onHead === 1 }),
      names: names.filter(n => n.variationId === row.id).map(n => n.name),
      ...(row.originName && { originName: row.originName }),
      ...(row.pending && {
        pending: JSON.parse(row.pending) as PendingConflicts,
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  private async one(rows: Row[]): Promise<StoredVariation | undefined> {
    return (await this.hydrate(rows.slice(0, 1)))[0];
  }

  /** The row with this id — for use inside an operation already serialized. */
  private async readById(
    id: VariationId,
  ): Promise<StoredVariation | undefined> {
    return this.one(
      await this.db.select().from(variations).where(eq(variations.id, id)),
    );
  }

  get(id: VariationId): Promise<StoredVariation | undefined> {
    return this.serialize(() => this.readById(id));
  }

  intern(v: VariationContent): Promise<StoredVariation> {
    const updates = serializeUpdates(v.updates);
    return this.serialize(async () => {
      const now = Date.now();
      await this.db
        .insert(variations)
        .values({
          id: mintVariationId(),
          promptId: v.promptId,
          globalId: v.globalId ?? null,
          baseVersion: v.base,
          updates,
          wip: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const found = await this.one(
        await this.db
          .select()
          .from(variations)
          .where(
            and(
              eq(variations.wip, 0),
              eq(variations.promptId, v.promptId),
              eq(variations.baseVersion, v.base),
              eq(variations.updates, updates),
            ),
          ),
      );
      if (!found) throw new Error("Interned variation vanished");
      return found;
    });
  }

  getWip(
    promptId: string,
    base: VersionId,
  ): Promise<StoredVariation | undefined> {
    return this.serialize(async () => {
      return this.one(
        await this.db
          .select()
          .from(variations)
          .where(
            and(
              eq(variations.wip, 1),
              eq(variations.promptId, promptId),
              eq(variations.baseVersion, base),
            ),
          ),
      );
    });
  }

  getHeadWip(promptId: string): Promise<StoredVariation | undefined> {
    return this.serialize(async () => {
      return this.one(
        await this.db
          .select()
          .from(variations)
          .where(
            and(
              eq(variations.wip, 1),
              eq(variations.onHead, 1),
              eq(variations.promptId, promptId),
            ),
          ),
      );
    });
  }

  listHeadWips(): Promise<StoredVariation[]> {
    return this.serialize(async () => {
      return this.hydrate(
        await this.db
          .select()
          .from(variations)
          .where(and(eq(variations.wip, 1), eq(variations.onHead, 1))),
      );
    });
  }

  putWip(v: NewWip): Promise<StoredVariation> {
    return this.serialize(async () => {
      const now = Date.now();
      const id = mintVariationId();
      await this.db.transaction(async tx => {
        // Whatever WIP held either slot this one takes is replaced by it.
        await tx
          .delete(variations)
          .where(
            and(
              eq(variations.wip, 1),
              eq(variations.promptId, v.promptId),
              or(
                eq(variations.baseVersion, v.base),
                v.onHead ? eq(variations.onHead, 1) : sql`0`,
              ),
            ),
          );
        await tx.insert(variations).values({
          id,
          promptId: v.promptId,
          globalId: v.globalId ?? null,
          baseVersion: v.base,
          updates: serializeUpdates(v.updates),
          wip: 1,
          onHead: v.onHead ? 1 : 0,
          originName: v.originName ?? null,
          createdAt: now,
          updatedAt: now,
        });
      });
      return (await this.readById(id))!;
    });
  }

  updateWip(id: VariationId, changes: WipChanges): Promise<StoredVariation> {
    return this.serialize(async () => {
      const set: Partial<typeof variations.$inferInsert> = {
        updatedAt: Date.now(),
      };
      if (changes.base !== undefined) set.baseVersion = changes.base;
      if (changes.updates !== undefined) {
        set.updates = serializeUpdates(changes.updates);
      }
      if (changes.onHead !== undefined) set.onHead = changes.onHead ? 1 : 0;
      if (changes.pending !== undefined) {
        set.pending = changes.pending && JSON.stringify(changes.pending);
      }
      if (changes.originName !== undefined) {
        set.originName = changes.originName;
      }
      await this.db.transaction(async tx => {
        // Moving onto a base another WIP of the same prompt already holds
        // displaces it: there is one WIP per (prompt, base).
        if (changes.base !== undefined) {
          const [row] = await tx
            .select({ promptId: variations.promptId })
            .from(variations)
            .where(eq(variations.id, id));
          if (row) {
            await tx
              .delete(variations)
              .where(
                and(
                  eq(variations.wip, 1),
                  eq(variations.promptId, row.promptId),
                  eq(variations.baseVersion, changes.base),
                  sql`${variations.id} <> ${id}`,
                ),
              );
          }
        }
        await tx
          .update(variations)
          .set(set)
          .where(and(eq(variations.id, id), eq(variations.wip, 1)));
      });
      const updated = await this.readById(id);
      if (!updated?.wip) throw new Error(`No WIP variation ${id}`);
      return updated;
    });
  }

  deleteWip(id: VariationId): Promise<void> {
    return this.serialize(async () => {
      await this.db
        .delete(variations)
        .where(and(eq(variations.id, id), eq(variations.wip, 1)));
    });
  }

  list(promptId: string): Promise<StoredVariation[]> {
    return this.serialize(async () => {
      const named = this.db
        .select({ id: variationNames.variationId })
        .from(variationNames)
        .where(eq(variationNames.promptId, promptId));
      return this.hydrate(
        await this.db
          .select()
          .from(variations)
          .where(
            or(
              and(eq(variations.wip, 1), eq(variations.promptId, promptId)),
              inArray(variations.id, named),
            ),
          )
          .orderBy(desc(variations.updatedAt)),
      );
    });
  }

  name(id: VariationId, promptId: string, name: string): Promise<void> {
    return this.serialize(async () => {
      await this.db
        .insert(variationNames)
        .values({ promptId, name, variationId: id, createdAt: Date.now() })
        .onConflictDoUpdate({
          target: [variationNames.promptId, variationNames.name],
          set: { variationId: id, createdAt: Date.now() },
        });
    });
  }

  unname(promptId: string, name: string): Promise<void> {
    return this.serialize(async () => {
      await this.db
        .delete(variationNames)
        .where(
          and(
            eq(variationNames.promptId, promptId),
            eq(variationNames.name, name),
          ),
        );
    });
  }

  async putBlob(content: string): Promise<string> {
    const sha = await sha256Hex(content);
    await this.serialize(() =>
      this.db
        .insert(blobs)
        .values({ sha256: sha, content })
        .onConflictDoNothing(),
    );
    return sha;
  }

  getBlob(sha256: string): Promise<string | undefined> {
    return this.serialize(async () => {
      const [row] = await this.db
        .select({ content: blobs.content })
        .from(blobs)
        .where(eq(blobs.sha256, sha256));
      return row?.content;
    });
  }

  recordSnapshot(path: string, sha256: string): Promise<FileSnapshotRecord> {
    return this.serialize(async () => {
      await this.db
        .insert(fileSnapshots)
        .values({ path, sha256, createdAt: Date.now() })
        .onConflictDoNothing();
      const [row] = await this.db
        .select()
        .from(fileSnapshots)
        .where(
          and(eq(fileSnapshots.path, path), eq(fileSnapshots.sha256, sha256)),
        );
      return row;
    });
  }

  listSnapshots(path: string): Promise<FileSnapshotRecord[]> {
    return this.serialize(async () => {
      return this.db
        .select()
        .from(fileSnapshots)
        .where(eq(fileSnapshots.path, path))
        .orderBy(desc(fileSnapshots.createdAt));
    });
  }

  getSnapshot(sha256: string): Promise<FileSnapshotRecord | undefined> {
    return this.serialize(async () => {
      const [row] = await this.db
        .select()
        .from(fileSnapshots)
        .where(eq(fileSnapshots.sha256, sha256))
        .orderBy(asc(fileSnapshots.createdAt))
        .limit(1);
      return row;
    });
  }
}
