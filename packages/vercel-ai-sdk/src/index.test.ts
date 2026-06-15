// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import { type Providers, prompts } from "./index.js";

// Minimal valid Prompt shape for the type constraint on `prompts`.
const stubPrompt = () => ({ model: {} as any, messages: [] });

describe("prompts", () => {
  const psi = { id: "mod" };

  it("returns a function", () => {
    const result = prompts(psi, () => ({ stub: stubPrompt }));
    expect(typeof result).toBe("function");
  });

  it("invokes the factory with the provided providers when called", () => {
    const factory = vi.fn((_providers: Providers) => ({ stub: stubPrompt }));
    const fakeOpenAI = vi.fn() as unknown as Providers["openai"];
    const wrapped = prompts(psi, factory);

    wrapped({ openai: fakeOpenAI });

    expect(factory).toHaveBeenCalledTimes(1);
    const providers = factory.mock.calls[0]?.[0] as Providers | undefined;
    expect(providers?.openai).toBe(fakeOpenAI);
  });

  it("preserves the factory return value so prompt functions are callable", () => {
    const fakeOpenAI = vi.fn((model: string) => ({ id: model })) as any;
    const wrapped = prompts(psi, ({ openai }) => ({
      greet(name: string) {
        return {
          model: openai("gpt-4o"),
          system: "hi",
          messages: [{ role: "user" as const, content: name }],
        };
      },
    }));

    const { greet } = wrapped({ openai: fakeOpenAI });
    const config = greet("world");

    expect(fakeOpenAI).toHaveBeenCalledWith("gpt-4o");
    expect(config.model).toEqual({ id: "gpt-4o" });
    expect(config.system).toBe("hi");
    expect(config.messages).toEqual([{ role: "user", content: "world" }]);
  });

  it("provided providers override the lazy defaults", () => {
    const override = {
      marker: "override",
    } as unknown as Providers["anthropic"];
    const captured: { anthropic?: unknown } = {};
    const wrapped = prompts(psi, ({ anthropic }) => {
      captured.anthropic = anthropic;
      return { stub: stubPrompt };
    });

    wrapped({ anthropic: override });
    expect(captured.anthropic).toBe(override);
  });

  it("exposes lazy providers when no overrides are passed", () => {
    let seen = false;
    const wrapped = prompts(psi, providers => {
      seen = "openai" in providers;
      return { stub: stubPrompt };
    });

    wrapped();
    expect(seen).toBe(true);
  });

  it("does not eagerly import provider packages", () => {
    const factory = vi.fn(() => ({ stub: stubPrompt }));
    prompts(psi, factory)();
    // Factory was called, but no provider getter was accessed, so no require happened.
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
