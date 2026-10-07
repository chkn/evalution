// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  type AgentCommandBuilder,
  ClaudeCodeCommandBuilder,
  CodexCommandBuilder,
  shellQuote,
} from "./command-builder.ts";

/**
 * The argv a POSIX shell parses `builder`'s command into, executable
 * included — by running it with the executable swapped for `printf`, so the
 * test sees exactly what the agent's CLI would.
 */
function shellArgv(builder: AgentCommandBuilder): string[] {
  const command = builder.build();
  expect(command.startsWith(`${builder.executable}`)).toBe(true);
  const args = command.slice(builder.executable.length);
  const out = execFileSync("sh", ["-c", `printf '%s\\0' ${args}`], {
    encoding: "utf8",
  });
  return [builder.executable, ...out.split("\0").slice(0, -1)];
}

/** Text that would break out of, or expand inside, a naively quoted argument. */
const NASTY = `it's "$HOME" \`whoami\` $(id) \\ & ; |`;

describe("shellQuote", () => {
  it("leaves shell-safe arguments bare", () => {
    expect(shellQuote("claude")).toBe("claude");
    expect(shellQuote("features.network_proxy.enabled=true")).toBe(
      "features.network_proxy.enabled=true",
    );
  });

  it("single-quotes anything else, escaping single quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("ClaudeCodeCommandBuilder", () => {
  it("runs bare `claude` with nothing set", () => {
    expect(new ClaudeCodeCommandBuilder().build()).toBe("claude");
  });

  it("puts the prompt before the variadic flags, so it isn't swallowed by them", () => {
    const argv = shellArgv(
      new ClaudeCodeCommandBuilder()
        .addAllowedDomain("evalut.io")
        .addMcpServer("evalution", "http://localhost:3000/mcp")
        .setPrompt("Do the thing"),
    );
    expect(argv[1]).toBe("Do the thing");
    expect(argv.slice(-2)).toEqual([
      "--allowedTools",
      "WebFetch(domain:evalut.io)",
    ]);
  });

  it("passes MCP servers as an --mcp-config JSON object of http servers", () => {
    const argv = shellArgv(
      new ClaudeCodeCommandBuilder()
        .addMcpServer("evalution", "http://localhost:3000/mcp")
        .addMcpServer("other", "http://localhost:4000/mcp"),
    );
    const config = argv[argv.indexOf("--mcp-config") + 1];
    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        evalution: { type: "http", url: "http://localhost:3000/mcp" },
        other: { type: "http", url: "http://localhost:4000/mcp" },
      },
    });
  });

  it("appends instructions to the system prompt, joined in order", () => {
    const argv = shellArgv(
      new ClaudeCodeCommandBuilder()
        .addInstructions("First.")
        .addInstructions("Second."),
    );
    expect(argv.slice(1)).toEqual(["--append-system-prompt", "First. Second."]);
  });

  it("allows every added domain", () => {
    const argv = shellArgv(
      new ClaudeCodeCommandBuilder()
        .addAllowedDomain("a.example")
        .addAllowedDomain("b.example"),
    );
    expect(argv.slice(1)).toEqual([
      "--allowedTools",
      "WebFetch(domain:a.example)",
      "WebFetch(domain:b.example)",
    ]);
  });

  it("keeps text with shell metacharacters intact as one argument", () => {
    const argv = shellArgv(
      new ClaudeCodeCommandBuilder().setPrompt(NASTY).addInstructions(NASTY),
    );
    expect(argv).toEqual(["claude", NASTY, "--append-system-prompt", NASTY]);
  });
});

describe("CodexCommandBuilder", () => {
  it("runs bare `codex` with nothing set", () => {
    expect(new CodexCommandBuilder().build()).toBe("codex");
  });

  it("allows domains through the network proxy, in one table, with the prompt last", () => {
    const argv = shellArgv(
      new CodexCommandBuilder()
        .setPrompt("Do the thing")
        .addAllowedDomain("a.example")
        .addAllowedDomain("b.example"),
    );
    expect(argv).toEqual([
      "codex",
      "-c",
      "features.network_proxy.enabled=true",
      "-c",
      'features.network_proxy.domains={ "a.example" = "allow", "b.example" = "allow" }',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "Do the thing",
    ]);
  });

  it("sets each MCP server's whole table, so it replaces a same-named one", () => {
    const argv = shellArgv(
      new CodexCommandBuilder().addMcpServer(
        "evalution",
        "http://localhost:3000/mcp",
      ),
    );
    expect(argv.slice(1)).toEqual([
      "-c",
      'mcp_servers.evalution={ url = "http://localhost:3000/mcp" }',
    ]);
  });

  it("passes instructions as a TOML-quoted developer_instructions", () => {
    const argv = shellArgv(
      new CodexCommandBuilder()
        .addInstructions("First.")
        .addInstructions(NASTY),
    );
    expect(argv.slice(1)).toEqual([
      "-c",
      `developer_instructions=${JSON.stringify(`First. ${NASTY}`)}`,
    ]);
  });
});

describe("AgentCommandBuilder.addMcpServer", () => {
  it("rejects a name that isn't a bare config key", () => {
    expect(() =>
      new CodexCommandBuilder().addMcpServer("a.b", "http://x"),
    ).toThrow("Invalid MCP server name");
    expect(() =>
      new ClaudeCodeCommandBuilder().addMcpServer("a b", "http://x"),
    ).toThrow("Invalid MCP server name");
  });
});
