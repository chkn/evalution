// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const watchers: EventEmitter[] = [];

vi.mock("chokidar", () => ({
  default: {
    watch: () => {
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
      watchers.push(watcher);
      return watcher;
    },
  },
}));

const { LocalFileProvider } = await import("./file-provider-local.ts");

afterEach(() => {
  watchers.length = 0;
  vi.restoreAllMocks();
});

describe("LocalFileProvider", () => {
  describe("watch", () => {
    it("logs watcher errors instead of crashing", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cleanup = new LocalFileProvider().watch(
        ["**/*.ts"],
        { cwd: "/project" },
        () => {},
      );

      const error = Object.assign(new Error("too many open files"), {
        code: "EMFILE",
      });
      // An EventEmitter throws on an "error" event nobody listens for.
      expect(() => watchers[0].emit("error", error)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("/project"),
        error,
      );
      cleanup();
    });
  });
});
