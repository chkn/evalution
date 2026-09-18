// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalFileProvider } from "../../file-provider-local.ts";
import { TSPromptFileType } from "../../prompt/file/ts/ts-prompt-file-type.ts";
import { TYPESAFE_FALLBACK } from "./fallback.ts";
import { TYPESAFE_PROJECT_PROBES } from "./probes.ts";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("TYPESAFE_FALLBACK", () => {
  it("matches what the probes resolve to against the installed SDK", async () => {
    const { project } = await new TSPromptFileType(
      new LocalFileProvider(),
    ).resolveTypes({
      project: { rootDir: root, probes: TYPESAFE_PROJECT_PROBES },
    });
    // If this fails after an SDK upgrade, regenerate the snapshot:
    //   node scripts/generate-typesafe-fallback.ts
    expect(project).toEqual(TYPESAFE_FALLBACK);
  });
});
