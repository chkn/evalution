// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * {@link VariationStore} backed by a Turso/libSQL database. fs-free: takes a
 * connected client, never a path — `openLocalVariationStore` is the Node-side
 * bootstrap. See `specs/prompt-versions-and-variations.md` §E.
 */

import type { Database } from "@tursodatabase/sync";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import type {
  FieldValues,
  NormalizedPromptUpdates,
  PendingConflicts,
  VariationId,
  VersionId,
} from "../../shared/types.ts";
import { serializeFieldValues, serializeUpdates } from "./canonical-updates.ts";
import { variationNames, variations } from "./db/schema.ts";
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
      ...(row.baseVersion && { base: row.baseVersion }),
      updates: JSON.parse(row.updates) as NormalizedPromptUpdates,
      baseValues: JSON.parse(row.baseValues) as FieldValues,
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
    const baseValues = serializeFieldValues(v.baseValues);
    const baseVersion = v.base ?? "";
    return this.serialize(async () => {
      const now = Date.now();
      await this.db
        .insert(variations)
        .values({
          id: mintVariationId(),
          promptId: v.promptId,
          globalId: v.globalId ?? null,
          baseVersion,
          updates,
          baseValues,
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
              eq(variations.baseVersion, baseVersion),
              eq(variations.updates, updates),
              eq(variations.baseValues, baseValues),
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
              eq(variations.onHead, 0),
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
        // Whatever WIP held the slot this one takes is replaced by it.
        await tx
          .delete(variations)
          .where(
            and(
              eq(variations.wip, 1),
              eq(variations.promptId, v.promptId),
              v.onHead
                ? eq(variations.onHead, 1)
                : and(
                    eq(variations.onHead, 0),
                    eq(variations.baseVersion, v.base ?? ""),
                  ),
            ),
          );
        await tx.insert(variations).values({
          id,
          promptId: v.promptId,
          globalId: v.globalId ?? null,
          baseVersion: v.base ?? "",
          updates: serializeUpdates(v.updates),
          baseValues: serializeFieldValues(v.baseValues),
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
      if (changes.updates !== undefined) {
        set.updates = serializeUpdates(changes.updates);
      }
      if (changes.baseValues !== undefined) {
        set.baseValues = serializeFieldValues(changes.baseValues);
      }
      if (changes.pending !== undefined) {
        set.pending = changes.pending && JSON.stringify(changes.pending);
      }
      if (changes.originName !== undefined) {
        set.originName = changes.originName;
      }
      await this.db
        .update(variations)
        .set(set)
        .where(and(eq(variations.id, id), eq(variations.wip, 1)));
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
}
