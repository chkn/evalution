// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";

describe("prompt programs", () => {
  afterEach(() => {
    vi.doUnmock("typescript");
    vi.resetModules();
  });

  // As it does outside Node: in the marketing site's in-browser demo, which
  // loads this module.
  it("load and build where TypeScript can't say where its libs are", async () => {
    vi.doMock("typescript", async importOriginal => {
      const { default: ts } = await importOriginal<{
        default: typeof import("typescript");
      }>();
      return {
        default: {
          ...ts,
          getDefaultLibFilePath: () => {
            throw new Error(
              "getDefaultLibFilePath is only supported when consumed as a node module.",
            );
          },
        },
      };
    });
    vi.resetModules();

    const { createPromptProgram } = await import("./prompt-program.ts");
    const program = createPromptProgram(
      new Map([["/project/prompt.ts", "export const answer = 42;"]]),
    );

    expect(program).toBeDefined();
  });
});
