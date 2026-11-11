// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The marketing site's demo runs `createMemoryApp` in a browser's service
 * worker, where TypeScript has no file system: `ts.sys` is undefined and
 * asking for its lib directory throws. Nothing on the way to serving the
 * prompts may lean on either.
 */
describe("the in-browser demo", () => {
  afterEach(() => {
    vi.doUnmock("typescript");
    vi.resetModules();
  });

  it("serves prompts where TypeScript has no file system", async () => {
    vi.doMock("typescript", async importOriginal => {
      const { default: ts } = await importOriginal<{
        default: typeof import("typescript");
      }>();
      return {
        default: {
          ...ts,
          sys: undefined,
          getDefaultLibFilePath: () => {
            throw new Error(
              "getDefaultLibFilePath is only supported when consumed as a node module.",
            );
          },
        },
      };
    });
    vi.resetModules();

    const { createMemoryApp } = await import("./service-worker.ts");
    const { app } = await createMemoryApp({
      files: {
        "/demo/cool.prompt.ts": `import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts({ id: "demo" }, ({ openai }) => ({
  weatherAgent: (query: string) => ({
    model: openai("gpt-5.5"),
    messages: [{ role: "user", content: query }],
  }),
}));
`,
        "/demo/.evalution/config.ts": "export default {};\n",
      },
    });
    const res = await app.request("/api/prompts");

    expect(res.status).toBe(200);
    expect((await res.json()).map((p: { name: string }) => p.name)).toEqual([
      "weatherAgent",
    ]);
  });
});
