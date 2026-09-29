// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { FileProvider } from "../../file-provider.ts";
import type {
  VersionHistoryOptions,
  VersionId,
  VersionInfo,
  VersioningAdapter,
} from "./versioning-adapter.ts";

/** Prefix of every version id {@link FileSnapshotVersioning} mints. */
const BLOB_PREFIX = "blob:";

/** The message every file snapshot carries. */
const FILE_SNAPSHOT_MESSAGE = "file contents only";

/** A recorded snapshot of one file. */
export interface FileSnapshotRecord {
  /** The file, relative to the provider's root. */
  path: string;
  /** SHA-256 of its content. */
  sha256: string;
  /** When the snapshot was first taken (ms). */
  createdAt: number;
}

/**
 * Where {@link FileSnapshotVersioning} keeps file contents and the record of
 * which file each snapshot was taken of. `TursoVariationStore` is one.
 */
export interface SnapshotBlobStore {
  /** Stores `content` (idempotently) and returns its SHA-256. */
  putBlob(content: string): Promise<string>;
  /** The content with this SHA-256, if stored. */
  getBlob(sha256: string): Promise<string | undefined>;
  /** Records that `path` was snapshotted with this content. Idempotent. */
  recordSnapshot(path: string, sha256: string): Promise<FileSnapshotRecord>;
  /** Every snapshot of `path`, newest first. */
  listSnapshots(path: string): Promise<FileSnapshotRecord[]>;
  /** The earliest snapshot of this content, of whichever file. */
  getSnapshot(sha256: string): Promise<FileSnapshotRecord | undefined>;
}

/**
 * The {@link VersioningAdapter} for a directory that isn't a git repository:
 * a version is the content of one prompt file, stored by its SHA-256. It
 * reproduces the prompt, not its tools — the UI labels these "file contents
 * only" — and exists so WIP editing and variations work without git. See
 * `specs/prompt-versions-and-variations.md` §C.4.
 */
export class FileSnapshotVersioning implements VersioningAdapter {
  readonly id = "file-snapshot";

  private readonly options: {
    rootDir: string;
    fileProvider: FileProvider;
    store: SnapshotBlobStore;
  };

  constructor(options: {
    /** The directory relative paths are relative to. */
    rootDir: string;
    /** Where the files being snapshotted are read from. */
    fileProvider: FileProvider;
    /** Where snapshots are kept. */
    store: SnapshotBlobStore;
  }) {
    this.options = options;
  }

  async snapshot(relativePath?: string): Promise<VersionInfo> {
    if (relativePath === undefined) {
      throw new Error(
        "File snapshots version one file at a time; name the file to snapshot",
      );
    }
    const { rootDir, fileProvider, store } = this.options;
    const content = await fileProvider.readFile(
      path.resolve(rootDir, relativePath),
    );
    const sha = await store.putBlob(content);
    return toInfo(await store.recordSnapshot(relativePath, sha));
  }

  async readFile(version: VersionId): Promise<string | undefined> {
    if (!version.startsWith(BLOB_PREFIX)) return undefined;
    return this.options.store.getBlob(version.slice(BLOB_PREFIX.length));
  }

  async history(
    relativePath: string,
    { limit, before }: VersionHistoryOptions = {},
  ): Promise<VersionInfo[]> {
    let list = (await this.options.store.listSnapshots(relativePath)).map(
      toInfo,
    );
    if (before) {
      const index = list.findIndex(v => v.id === before);
      if (index >= 0) list = list.slice(index + 1);
    }
    return limit !== undefined ? list.slice(0, limit) : list;
  }

  async get(id: VersionId): Promise<VersionInfo | undefined> {
    if (!id.startsWith(BLOB_PREFIX)) return undefined;
    const record = await this.options.store.getSnapshot(
      id.slice(BLOB_PREFIX.length),
    );
    return record && toInfo(record);
  }
}

function toInfo(record: FileSnapshotRecord): VersionInfo {
  return {
    id: `${BLOB_PREFIX}${record.sha256}`,
    kind: "snapshot",
    message: FILE_SNAPSHOT_MESSAGE,
    time: record.createdAt,
    fileOnly: true,
  };
}
