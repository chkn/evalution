// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentContext } from "../shared/agent.ts";
import {
  AskAgentNotFoundError,
  buildAskAgentCommand,
  describeAgentContext,
  listAgents,
} from "./agents.ts";
import type { ApiContext } from "./api-context.ts";

const ROOT = path.join(path.sep, "proj");
const PROMPT_ID = "src/greet.prompt.ts#greet";

/**
 * Just enough of an {@link ApiContext} for the lookups an agent's context
 * needs: one prompt (in a file), one trace, one dataset, and one eval, each
 * under provider `p` — plus `nofile`, a prompt provider without source paths.
 */
function fakeApi(): ApiContext {
  const prompt = { id: PROMPT_ID, name: "greet" };
  return {
    rootPath: ROOT,
    promptProviders: new Map<string, unknown>([
      [
        "p",
        {
          getPrompt: async (id: string) => (id === PROMPT_ID ? prompt : null),
          getSourcePath: () => path.join(ROOT, "src", "greet.prompt.ts"),
        },
      ],
      [
        "nofile",
        {
          getPrompt: async (id: string) =>
            id === "x" ? { id, name: "x" } : null,
        },
      ],
    ]),
    traceProviders: new Map([
      [
        "p",
        {
          getTrace: async (id: string) =>
            id === "t1"
              ? { trace: { id, name: "chat" }, spans: [] }
              : undefined,
        },
      ],
    ]),
    datasetProviders: new Map([
      [
        "p",
        {
          getDataset: async (id: string) =>
            id === "d1" ? { id, name: "Golden set" } : undefined,
        },
      ],
    ]),
    evalProviders: new Map([
      [
        "p",
        {
          getEval: async (id: string) =>
            id === "e1" ? { id, name: "Tone check" } : undefined,
        },
      ],
    ]),
  } as unknown as ApiContext;
}

describe("describeAgentContext", () => {
  it("names a prompt and the file it's in, relative to the project root", async () => {
    expect(
      await describeAgentContext(fakeApi(), {
        type: "prompt",
        providerId: "p",
        promptId: PROMPT_ID,
      }),
    ).toBe(
      `Currently viewing prompt "greet" in @src/greet.prompt.ts (prompt id "${PROMPT_ID}").`,
    );
  });

  it("leaves out the file for a provider without source paths", async () => {
    expect(
      await describeAgentContext(fakeApi(), {
        type: "prompt",
        providerId: "nofile",
        promptId: "x",
      }),
    ).toBe(`Currently viewing prompt "x" (prompt id "x").`);
  });

  it("names a trace, dataset, or eval by id and name", async () => {
    const api = fakeApi();
    expect(
      await describeAgentContext(api, {
        type: "trace",
        providerId: "p",
        traceId: "t1",
      }),
    ).toBe(`Currently viewing trace t1 ("chat").`);
    expect(
      await describeAgentContext(api, {
        type: "dataset",
        providerId: "p",
        datasetId: "d1",
      }),
    ).toBe(`Currently viewing dataset "Golden set" (dataset id "d1").`);
    expect(
      await describeAgentContext(api, {
        type: "eval",
        providerId: "p",
        evalId: "e1",
      }),
    ).toBe(`Currently viewing eval "Tone check" (eval id "e1").`);
  });

  it("throws AskAgentNotFoundError for an unknown provider or entity", async () => {
    const missing: AgentContext[] = [
      { type: "prompt", providerId: "p", promptId: "nope#x" },
      { type: "prompt", providerId: "nope", promptId: PROMPT_ID },
      { type: "trace", providerId: "p", traceId: "nope" },
      { type: "dataset", providerId: "nope", datasetId: "d1" },
      { type: "eval", providerId: "p", evalId: "nope" },
    ];
    for (const context of missing) {
      await expect(
        describeAgentContext(fakeApi(), context),
      ).rejects.toBeInstanceOf(AskAgentNotFoundError);
    }
  });
});

describe("buildAskAgentCommand", () => {
  const trace: AgentContext = { type: "trace", providerId: "p", traceId: "t1" };

  it("connects Claude Code to the MCP server and tells it what's being viewed", async () => {
    const command = await buildAskAgentCommand(
      fakeApi(),
      "http://localhost:3000/mcp",
      "claude-code",
      trace,
    );
    expect(command).toMatch(/^claude --append-system-prompt '/);
    expect(command).toContain(`Currently viewing trace t1 ("chat").`);
    expect(command).toContain(
      `--mcp-config '{"mcpServers":{"evalution":{"type":"http","url":"http://localhost:3000/mcp"}}}'`,
    );
  });

  it("connects Codex the same way, through config overrides", async () => {
    const command = await buildAskAgentCommand(
      fakeApi(),
      "http://localhost:3000/mcp",
      "codex",
      trace,
    );
    expect(command).toMatch(/^codex -c /);
    expect(command).toContain(
      `'mcp_servers.evalution={ url = "http://localhost:3000/mcp" }'`,
    );
    expect(command).toContain("developer_instructions=");
    expect(command).toContain(`Currently viewing trace t1`);
  });

  it("throws AskAgentNotFoundError for an unknown agent", async () => {
    await expect(
      buildAskAgentCommand(fakeApi(), "http://x/mcp", "nope", trace),
    ).rejects.toBeInstanceOf(AskAgentNotFoundError);
  });
});

describe("listAgents", () => {
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    // A PATH holding only a fake `codex`, so the result doesn't depend on
    // which agents this machine happens to have installed.
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-agents-"));
    const codex = path.join(binDir, "codex");
    await fs.writeFile(codex, "#!/bin/sh\n");
    await fs.chmod(codex, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = binDir;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("lists every agent, marking those whose CLI isn't on PATH", () => {
    expect(listAgents()).toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        icon: "Anthropic",
        disabledReason: "claude not found in PATH",
      },
      { id: "codex", label: "Codex", icon: "OpenAI" },
    ]);
  });
});
