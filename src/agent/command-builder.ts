// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Builds the shell command line that launches a coding agent's CLI, so callers
 * describe *what* the agent should get (a prompt, network access, an MCP
 * server, extra instructions) and each agent's subclass decides *how* its CLI
 * spells it.
 *
 * The output is run through the user's shell (see `../server/terminal.ts`), so
 * every argument is shell-quoted: values may carry arbitrary text — names,
 * paths — without being able to break out of their argument.
 */

/** An MCP server the agent should connect to over streamable HTTP. */
export interface AgentMcpServer {
  /** The server's name in the agent's config — what its tools are prefixed with. */
  name: string;
  /** The server's streamable-HTTP endpoint, e.g. `http://localhost:3000/mcp`. */
  url: string;
}

/** Characters an argument may consist of to be left unquoted. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** MCP server names, restricted so they work as a bare key in every agent's config. */
const MCP_SERVER_NAME = /^[\w-]+$/;

/**
 * `arg` quoted for a POSIX shell: left bare when it's made only of characters
 * no shell treats specially, otherwise single-quoted, with any single quotes
 * inside it closed, escaped, and reopened.
 */
export function shellQuote(arg: string): string {
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Collects what a coding agent should be launched with, then
 * {@link AgentCommandBuilder.build | builds} the command line for one agent's
 * CLI. Every setter returns the builder, so calls chain.
 */
export abstract class AgentCommandBuilder {
  /** The CLI executable this builder's commands run, e.g. `claude`. */
  abstract readonly executable: string;

  /** The initial prompt, if any. */
  protected prompt: string | undefined;
  /** Domains the agent may fetch from without asking. */
  protected readonly allowedDomains: string[] = [];
  /** MCP servers to connect to, beyond the user's own config. */
  protected readonly mcpServers: AgentMcpServer[] = [];
  /** Extra system/developer instructions, in the order added. */
  protected readonly instructions: string[] = [];

  /** Sets the prompt the agent starts working on. Without one, it waits for the user. */
  setPrompt(prompt: string): this {
    this.prompt = prompt;
    return this;
  }

  /** Lets the agent fetch from `domain` without asking first. */
  addAllowedDomain(domain: string): this {
    this.allowedDomains.push(domain);
    return this;
  }

  /**
   * Connects the agent to the streamable-HTTP MCP server at `url`, as `name`.
   *
   * @throws if `name` has characters other than letters, digits, `_` and `-`.
   */
  addMcpServer(name: string, url: string): this {
    if (!MCP_SERVER_NAME.test(name))
      throw new Error(`Invalid MCP server name: ${name}`);
    this.mcpServers.push({ name, url });
    return this;
  }

  /**
   * Adds to the agent's system (Claude Code) or developer (Codex)
   * instructions. Several are joined with a space, in the order added — not a
   * newline, so the command stays on one line when it's shown in a terminal.
   */
  addInstructions(text: string): this {
    this.instructions.push(text);
    return this;
  }

  /** The shell command line that launches the agent with everything set so far. */
  build(): string {
    return [this.executable, ...this.buildArgs()].map(shellQuote).join(" ");
  }

  /** The CLI arguments, unquoted — {@link build} quotes them. */
  protected abstract buildArgs(): string[];

  /** Every added instruction, as one string, or `undefined` if none. */
  protected joinedInstructions(): string | undefined {
    return this.instructions.length > 0
      ? this.instructions.join(" ")
      : undefined;
  }
}

/** Builds `claude` command lines. */
export class ClaudeCodeCommandBuilder extends AgentCommandBuilder {
  readonly executable = "claude";

  protected buildArgs(): string[] {
    const args: string[] = [];
    // The prompt must come first: `--allowedTools` and `--mcp-config` are
    // variadic (`<tools...>`), so anything after them — including the prompt —
    // is swallowed as another value and never reaches the CLI's positional.
    if (this.prompt !== undefined) args.push(this.prompt);
    const instructions = this.joinedInstructions();
    if (instructions) args.push("--append-system-prompt", instructions);
    if (this.mcpServers.length > 0) {
      const mcpServers = Object.fromEntries(
        this.mcpServers.map(({ name, url }) => [name, { type: "http", url }]),
      );
      args.push("--mcp-config", JSON.stringify({ mcpServers }));
    }
    if (this.allowedDomains.length > 0) {
      args.push(
        "--allowedTools",
        ...this.allowedDomains.map(domain => `WebFetch(domain:${domain})`),
      );
    }
    return args;
  }
}

/**
 * Builds `codex` command lines. Everything but the prompt is passed as a
 * `-c key=value` config override, whose value Codex parses as TOML — and a
 * JSON string is a valid TOML basic string, so `JSON.stringify` quotes them.
 */
export class CodexCommandBuilder extends AgentCommandBuilder {
  readonly executable = "codex";

  protected buildArgs(): string[] {
    const args: string[] = [];
    const config = (keyValue: string) => args.push("-c", keyValue);
    if (this.allowedDomains.length > 0) {
      // See https://developers.openai.com/codex/agent-approvals-security#network-isolation
      const domains = this.allowedDomains
        .map(domain => `${JSON.stringify(domain)} = "allow"`)
        .join(", ");
      config("features.network_proxy.enabled=true");
      config(`features.network_proxy.domains={ ${domains} }`);
      config("sandbox_workspace_write.network_access=true");
    }
    for (const { name, url } of this.mcpServers) {
      // The whole table, not just `.url`: an override replaces what's at its
      // path, so a same-named stdio server in the user's config (`command =
      // ...`) is swapped out rather than merged into one with both.
      config(`mcp_servers.${name}={ url = ${JSON.stringify(url)} }`);
    }
    const instructions = this.joinedInstructions();
    if (instructions)
      config(`developer_instructions=${JSON.stringify(instructions)}`);
    if (this.prompt !== undefined) args.push(this.prompt);
    return args;
  }
}
