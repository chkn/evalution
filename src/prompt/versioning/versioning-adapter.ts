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

/** What the working tree is checked out at. */
export interface HeadState {
  /** The commit checked out, or `undefined` before the first commit. */
  commit?: VersionInfo;
  /** Whether the working tree matches {@link commit}: nothing uncommitted. */
  clean: boolean;
}

/**
 * Names states of the world for a {@link FilePromptProvider} — commits — so a
 * trace can record which content of a prompt it ran and an old one can be
 * read back.
 *
 * An adapter speaks paths, relative to the provider's `rootDir`; the provider
 * maps prompt ids to them. See `specs/prompt-versions-and-variations.md` §C.
 */
export interface VersioningAdapter {
  /** Identifies the adapter, e.g. `"git"`. */
  readonly id: string;

  /** The commit checked out, and whether the working tree has changes on top. */
  head(): Promise<HeadState>;

  /** A file's content at a version, or `undefined` if it didn't exist there. */
  readFile(
    version: VersionId,
    relativePath: string,
  ): Promise<string | undefined>;

  /**
   * Versions that changed `relativePath`, newest first — what a version
   * selector lists.
   */
  history(
    relativePath: string,
    options?: VersionHistoryOptions,
  ): Promise<VersionInfo[]>;

  /** Describes a version, or `undefined` when there is no such version. */
  get(id: VersionId): Promise<VersionInfo | undefined>;
}
