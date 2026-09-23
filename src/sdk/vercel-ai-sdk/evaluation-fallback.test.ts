// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalFileProvider } from "../../file-provider-local.ts";
import { TSPromptFileType } from "../../prompt/file/ts/ts-prompt-file-type.ts";
import { EVALUATION_PROJECT_PROBES } from "./evaluation.ts";
import { VERCEL_EVALUATION_FALLBACK } from "./evaluation-fallback.ts";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("VERCEL_EVALUATION_FALLBACK", () => {
  it("matches what the probes resolve to against the installed `ai`", async () => {
    const { project } = await new TSPromptFileType(
      new LocalFileProvider(),
    ).resolveTypes({
      project: { rootDir: root, probes: EVALUATION_PROJECT_PROBES },
    });
    // If this fails after an SDK upgrade, regenerate the snapshot:
    //   node scripts/generate-probe-fallbacks.ts
    expect(project).toEqual(VERCEL_EVALUATION_FALLBACK);
  });
});
