// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  it("defaults to `ui` in the current directory on loopback", () => {
    expect(parseCliArgs([])).toEqual({ command: "ui" });
  });

  it("reads a command and a path", () => {
    expect(parseCliArgs(["mcp", "proj"])).toEqual({
      command: "mcp",
      path: "proj",
    });
  });

  it.each([
    [["--host", "0.0.0.0"]],
    [["--host=0.0.0.0"]],
    [["ui", "--host", "0.0.0.0", "proj"]],
    [["ui", "proj", "--host=0.0.0.0"]],
  ])("reads --host anywhere among %j", argv => {
    expect(parseCliArgs(argv)).toMatchObject({
      command: "ui",
      host: "0.0.0.0",
    });
  });

  it("keeps a path alongside --host", () => {
    expect(parseCliArgs(["ui", "proj", "--host", "::"])).toEqual({
      command: "ui",
      path: "proj",
      host: "::",
    });
  });

  it.each([
    [["--host"], "--host needs an address"],
    [["--host="], "--host needs an address"],
    [["mcp", "--host", "0.0.0.0"], "--host only applies to `evalution ui`"],
    [["serve"], "Unknown command: serve"],
    [["--port", "4000"], "Unknown option: --port"],
    [["ui", "a", "b"], "Unexpected argument: b"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});
