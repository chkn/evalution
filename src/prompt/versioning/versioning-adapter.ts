// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { VersionId, VersionInfo } from "../../shared/types.ts";

export type { VersionId, VersionInfo };

/** Options for {@link VersioningAdapter.history}. */
export interface VersionHistoryOptions {
  /** At most this many versions. */
  limit?: number;
  /** Only versions listed after (older than) this one — for paging. */
  before?: VersionId;
}

/**
 * Names states of the world for a {@link FilePromptProvider}, so a trace can
 * record which content of a prompt it ran and an old one can be read back.
 *
 * An adapter speaks paths, relative to the provider's `rootDir`; the provider
 * maps prompt ids to them. See `specs/prompt-versions-and-variations.md` §C.
 */
export interface VersioningAdapter {
  /** Identifies the adapter, e.g. `"git"`. */
  readonly id: string;

  /**
   * Pins head as a version and returns it. Cheap when nothing changed since
   * the last call.
   *
   * @param relativePath - The file the caller is about to depend on. An
   *   adapter that versions the whole project (git) ignores it; one that
   *   versions single files ({@link FileSnapshotVersioning}) snapshots just
   *   that file, and requires it.
   */
  snapshot(relativePath?: string): Promise<VersionInfo>;

  /** A file's content at a version, or `undefined` if it didn't exist there. */
  readFile(
    version: VersionId,
    relativePath: string,
  ): Promise<string | undefined>;

  /**
   * Versions whose copy of `relativePath` differs from the version before
   * them, newest first — what a version selector lists.
   */
  history(
    relativePath: string,
    options?: VersionHistoryOptions,
  ): Promise<VersionInfo[]>;

  /** Describes a version, or `undefined` when there is no such version. */
  get(id: VersionId): Promise<VersionInfo | undefined>;

  /**
   * Forgets any memoized {@link snapshot}, because something on disk changed.
   * Optional: an adapter that memoizes nothing has nothing to forget.
   */
  invalidate?(): void;
}
