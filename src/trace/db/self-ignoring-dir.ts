// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Node-side (fs-allowed) helper for the local stores' directories — traces
 * and datasets are local, gitignored state.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Creates `dir` (and any missing parents). If this call is what created it,
 * also writes `dir/.gitignore` containing `patterns`, so the directory ignores
 * itself and its contents with no change to the project's own `.gitignore`.
 *
 * A directory that already existed is left alone: it may be somewhere the
 * user chose (the project root, say), and ignoring everything in it would be
 * a nasty surprise.
 */
export async function mkdirSelfIgnoring(
  dir: string,
  patterns: string[],
): Promise<void> {
  const created = await mkdir(dir, { recursive: true });
  if (created === undefined) return;
  try {
    await writeFile(join(dir, ".gitignore"), patterns.join("\n") + "\n", {
      flag: "wx",
    });
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }
}
