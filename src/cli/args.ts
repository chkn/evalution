// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** The command line's usage summary, printed with any parse error. */
export const USAGE =
  "Usage: evalution [ui [path] [--host <address>]] | evalution mcp [path]";

/** What the command line asks for, as {@link parseCliArgs} reads it. */
export interface CliArgs {
  /** `ui` (the default) serves the playground; `mcp` serves MCP over stdio. */
  command: "ui" | "mcp";
  /** Where to start looking for the project, if not the current directory. */
  path?: string;
  /** The address `ui` listens on, if `--host` gave one. */
  host?: string;
}

/**
 * Parses the CLI's arguments (`process.argv` minus the node and script
 * paths): an optional command, an optional path, and — for `ui` only —
 * `--host <address>` or `--host=<address>`, anywhere among them.
 *
 * @throws with a message for the user on an unknown command or flag, a
 *   missing `--host` value, an extra argument, or `--host` with `mcp`.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host" || arg.startsWith("--host=")) {
      host = arg === "--host" ? argv[++i] : arg.slice("--host=".length);
      if (!host) throw new Error("--host needs an address, e.g. 0.0.0.0");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [command = "ui", path, ...extra] = positional;
  if (command !== "ui" && command !== "mcp")
    throw new Error(`Unknown command: ${command}`);
  if (extra.length > 0) throw new Error(`Unexpected argument: ${extra[0]}`);
  // The MCP holder only ever listens on loopback, for the relays beside it.
  if (command === "mcp" && host !== undefined)
    throw new Error("--host only applies to `evalution ui`");
  return { command, path, host };
}
