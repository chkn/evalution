// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { beforeEach, describe, expect, it, vi } from "vitest";
import { VercelAISDK } from "./vercel-ai-sdk.ts";

// `ai` is an optional peer dependency that the adapter imports lazily inside
// `executeConfig`. Mock it so the test exercises that dynamic-import path
// without depending on the real package being resolvable.
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock("ai", () => ({ generateText: generateTextMock }));

describe("VercelAISDK", () => {
  const sdk = new VercelAISDK();

  describe("executeConfig", () => {
    beforeEach(() => generateTextMock.mockReset());

    it("lazily imports `ai` and delegates to generateText with the config", async () => {
      const config = { model: "anthropic/claude-opus-4-8", prompt: "hi" };
      await sdk.executeConfig(config);
      expect(generateTextMock).toHaveBeenCalledTimes(1);
      expect(generateTextMock).toHaveBeenCalledWith(config);
    });
  });

  describe("getModelCatalog", () => {
    it("exposes both OpenAI and Anthropic provider groups", async () => {
      const catalog = await sdk.getModelCatalog();
      const groups = new Set(catalog.models.map(m => m.group));
      expect(groups.has("OpenAI")).toBe(true);
      expect(groups.has("Anthropic")).toBe(true);
    });

    it("includes Claude models with function and gateway-string values", async () => {
      const catalog = await sdk.getModelCatalog();
      const claudeModels = catalog.models.filter(m => m.group === "Anthropic");
      expect(claudeModels.length).toBeGreaterThan(0);

      for (const model of claudeModels) {
        expect(model.id.startsWith("anthropic/")).toBe(true);
        expect(model.label.toLowerCase()).toContain("claude");

        const fn = model.values.function;
        expect(fn?.kind).toBe("functionCall");
        if (fn?.kind === "functionCall") {
          expect(fn.callee).toBe("anthropic");
          expect(fn.binding).toEqual([
            {
              kind: "parameter",
              enclosingCall: {
                callee: "prompts",
                import: { name: "prompts", from: "@evalution/vercel-ai-sdk" },
              },
            },
            {
              kind: "import",
              spec: { name: "anthropic", from: "@ai-sdk/anthropic" },
            },
          ]);
        }

        const str = model.values.string;
        expect(str?.kind).toBe("primitive");
        if (str?.kind === "primitive") {
          expect(String(str.value).startsWith("anthropic/")).toBe(true);
        }
      }
    });

    it("exposes a customValueTemplates entry for Anthropic so users can type a custom model id", async () => {
      const catalog = await sdk.getModelCatalog();
      const template =
        catalog.groups?.Anthropic?.customValueTemplates?.function;
      expect(template?.kind).toBe("functionCall");
      if (template?.kind === "functionCall") {
        expect(template.callee).toBe("anthropic");
        expect(template.args[0]).toEqual({
          kind: "primitive",
          value: "$input",
        });
      }
    });
  });
});
