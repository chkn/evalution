// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentValue } from "./persistent-value.ts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPersistentValue", () => {
  it("starts from the fallback when nothing is stored", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const value = createPersistentValue("k", "fallback", raw => raw);
    expect(value.get()).toBe("fallback");
  });

  it("reads the parsed stored value on creation", () => {
    const storage = memoryStorage();
    storage.setItem("k", "42");
    vi.stubGlobal("localStorage", storage);
    const value = createPersistentValue("k", 0, raw => Number(raw));
    expect(value.get()).toBe(42);
  });

  it("persists on set and notifies subscribers", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const value = createPersistentValue("k", false, raw => raw === "true");

    const listener = vi.fn();
    const unsubscribe = value.subscribe(listener);

    value.set(true);
    expect(value.get()).toBe(true);
    expect(storage.getItem("k")).toBe("true");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    value.set(false);
    expect(listener).toHaveBeenCalledTimes(1); // not called after unsubscribing
  });

  it("falls back rather than throwing when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const value = createPersistentValue("k", "fallback", raw => raw);
    expect(value.get()).toBe("fallback");
    // Doesn't throw even though the underlying `setItem` does.
    expect(() => value.set("next")).not.toThrow();
    expect(value.get()).toBe("next");
  });
});
