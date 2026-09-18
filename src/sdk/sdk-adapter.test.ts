// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { GeminiInteractionsSDK } from "./gemini-interactions-sdk.ts";
import {
  assertUpdateStyle,
  isMissingPackage,
  missingPackageMessage,
} from "./sdk-adapter.ts";
import { VercelAISDK } from "./vercel-ai-sdk/index.ts";

/** The error Node throws when a bare specifier resolves to nothing. */
function moduleNotFound(message: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

describe("isMissingPackage", () => {
  it("recognizes the package itself being uninstalled", () => {
    const err = moduleNotFound(
      "Cannot find package 'ai' imported from /npx/node_modules/evalution/dist/bundle.js",
    );
    expect(isMissingPackage(err, "ai")).toBe(true);
  });

  it("does not confuse a different missing package for this one", () => {
    const err = moduleNotFound(
      "Cannot find package '@google/genai' imported from /project/config.ts",
    );
    expect(isMissingPackage(err, "ai")).toBe(false);
  });

  it("does not swallow a broken dependency *inside* the package", () => {
    // `ai` is installed, but something it imports is not — a real error.
    const err = moduleNotFound(
      "Cannot find package 'zod' imported from /project/node_modules/ai/dist/index.js",
    );
    expect(isMissingPackage(err, "ai")).toBe(false);
  });

  it("ignores errors that aren't module-resolution failures", () => {
    expect(isMissingPackage(new Error("Cannot find package 'ai'"), "ai")).toBe(
      false,
    );
    expect(isMissingPackage(undefined, "ai")).toBe(false);
  });
});

describe("isMissingPackage through wrappers", () => {
  it("recognizes a missing package wrapped by a loader", () => {
    const wrapped = new Error("There was an error when loading a module", {
      cause: moduleNotFound("Cannot find package 'ai' imported from /x.js"),
    });
    expect(isMissingPackage(wrapped, "ai")).toBe(true);
    expect(isMissingPackage(wrapped, "@google/genai")).toBe(false);
  });
});

describe("missingPackageMessage", () => {
  it("names the package and how to install it", () => {
    expect(missingPackageMessage("ai")).toContain("npm install ai");
  });
});

describe("assertUpdateStyle", () => {
  it("accepts updates in the adapter's own style", () => {
    expect(() =>
      assertUpdateStyle({ style: "chat", system: null }, "chat"),
    ).not.toThrow();
  });

  it("rejects updates written for another style", () => {
    expect(() =>
      assertUpdateStyle({ style: "questions", questions: null }, "chat"),
    ).toThrow(/"questions" updates to a "chat" prompt/);
  });
});

describe("chat adapters", () => {
  it.each([
    ["VercelAISDK", new VercelAISDK()],
    ["GeminiInteractionsSDK", new GeminiInteractionsSDK()],
  ])("%s refuses to denormalize questions-style updates", (_, sdk) => {
    expect(() =>
      sdk.denormalizeUpdates({
        style: "questions",
        state: { kind: "primitive", value: "x" },
      }),
    ).toThrow(/"questions" updates/);
  });
});
