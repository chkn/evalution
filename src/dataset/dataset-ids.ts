// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Id minting shared by the dataset providers. fs-free.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A short random row id: 10 base-62 characters, about 60 bits. Not a UUID,
 * because the id repeats in every row; not an integer, because rows created
 * offline in two replicas must not collide once they sync.
 */
export function mintRowId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  // 256 % 62 = 8, so the first eight symbols are very slightly likelier —
  // irrelevant at this length, where the id only has to be unique per dataset.
  for (const b of bytes) id += BASE62[b % 62];
  return id;
}

/** The field id for counter value `n`: base 36, so `0`–`9`, `a`–`z`, `10`, …. */
export function fieldIdFor(n: number): string {
  return n.toString(36);
}

/** Longest id {@link slugifyDatasetName} produces, before any `-N` suffix. */
const MAX_SLUG_LENGTH = 60;

/**
 * A dataset id derived from its name: `Support tickets` → `support-tickets`.
 * Always matches {@link isValidDatasetId}; falls back to `dataset` for a
 * name with no usable characters.
 */
export function slugifyDatasetName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug || "dataset";
}

/**
 * The first of `base`, `base-2`, `base-3`, … that `taken` doesn't report as
 * already used.
 */
export function uniqueDatasetId(
  base: string,
  taken: (id: string) => boolean,
): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Whether `id` is a well-formed dataset id. A local dataset's id is a file
 * name, so anything arriving over REST is checked against this before it gets
 * anywhere near a path.
 */
export function isValidDatasetId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(id);
}
