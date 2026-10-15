// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * "Ask a coding agent" from the prompt, trace, dataset, and eval views: which
 * agents can be launched, and the command line that launches one connected to
 * this server's MCP endpoint and told what the user is looking at.
 */

import path from "node:path";
import { CODING_AGENTS, findAgent } from "../agent/registry.ts";
import type { AgentContext, AgentInfo } from "../shared/agent.ts";
import type { ApiContext } from "./api-context.ts";
import { missingBinaryReason } from "./setup-tasks.ts";

/** The name evalution's MCP server is given in a launched agent's config. */
export const AGENT_MCP_SERVER_NAME = "evalution";

/** Tells a launched agent where it came from and what the MCP server is for. */
const AGENT_PREAMBLE =
  "The user launched you from the evalution UI for this project. " +
  `Use the \`${AGENT_MCP_SERVER_NAME}\` MCP server to read and change the prompts, traces, datasets, and evals in this project.`;

/**
 * Thrown when an agent, or the entity an {@link AgentContext} names, doesn't
 * exist. The route layer maps this to a 404.
 */
export class AskAgentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskAgentNotFoundError";
  }
}

/**
 * Every coding agent in the registry, in display order — each one whose CLI
 * isn't on `PATH` with a `disabledReason` saying so.
 */
export function listAgents(): AgentInfo[] {
  return CODING_AGENTS.map(({ id, label, icon, commandBuilder }) => {
    const disabledReason = missingBinaryReason(commandBuilder().executable);
    return { id, label, icon, ...(disabledReason && { disabledReason }) };
  });
}

/**
 * One sentence telling an agent what the user is looking at, from the entity
 * `context` names as this server finds it — so nothing the client sends
 * reaches the agent's instructions verbatim.
 *
 * @throws {AskAgentNotFoundError} if the provider or entity doesn't exist.
 */
export async function describeAgentContext(
  api: ApiContext,
  context: AgentContext,
): Promise<string> {
  const notFound = (what: string) =>
    new AskAgentNotFoundError(
      `No ${what} found for ${JSON.stringify(context)}`,
    );
  switch (context.type) {
    case "prompt": {
      const provider = api.promptProviders.get(context.providerId);
      const prompt = await provider?.getPrompt(context.promptId);
      if (!provider || !prompt) throw notFound("prompt");
      const sourcePath = provider.getSourcePath?.(prompt);
      const where = sourcePath
        ? ` in @${path.relative(api.rootPath, sourcePath).split(path.sep).join("/")}`
        : "";
      return `Currently viewing prompt ${JSON.stringify(prompt.name)}${where} (prompt id ${JSON.stringify(prompt.id)}).`;
    }
    case "trace": {
      const trace = await api.traceProviders
        .get(context.providerId)
        ?.getTrace(context.traceId);
      if (!trace) throw notFound("trace");
      return `Currently viewing trace ${trace.trace.id} (${JSON.stringify(trace.trace.name)}).`;
    }
    case "dataset": {
      const dataset = await api.datasetProviders
        .get(context.providerId)
        ?.getDataset(context.datasetId);
      if (!dataset) throw notFound("dataset");
      const viewing = `Currently viewing dataset ${JSON.stringify(dataset.name)} (dataset id ${JSON.stringify(dataset.id)})`;
      const rowIds = await selectedRowIds(api, context);
      if (rowIds.length === 0) return `${viewing}.`;
      const one = rowIds.length === 1;
      const ids = rowIds.map(id => JSON.stringify(id)).join(", ");
      return `${viewing}, with ${rowIds.length} ${one ? "row" : "rows"} selected (row ${one ? "id" : "ids"} ${ids}).`;
    }
    case "eval": {
      const def = await api.evalProviders
        .get(context.providerId)
        ?.getEval(context.evalId);
      if (!def) throw notFound("eval");
      return `Currently viewing eval ${JSON.stringify(def.name)} (eval id ${JSON.stringify(def.id)}).`;
    }
  }
}

/**
 * The ids of the rows a dataset context says are selected that the dataset
 * has, in its order — the server's own, so nothing else the client sends
 * reaches the agent.
 */
async function selectedRowIds(
  api: ApiContext,
  context: Extract<AgentContext, { type: "dataset" }>,
): Promise<string[]> {
  if (!context.rowIds?.length) return [];
  const selected = new Set(context.rowIds);
  const rows = await api.datasetProviders
    .get(context.providerId)
    ?.listRows(context.datasetId);
  return (rows ?? []).filter(row => selected.has(row.id)).map(row => row.id);
}

/**
 * The command line that launches the agent `agentId` connected to the MCP
 * server at `mcpUrl` and told what `context` names.
 *
 * @param api - What `context` is looked up in.
 * @param mcpUrl - This server's MCP endpoint, e.g. `http://localhost:3000/mcp`.
 * @throws {AskAgentNotFoundError} if the agent, or what `context` names,
 *   doesn't exist.
 */
export async function buildAskAgentCommand(
  api: ApiContext,
  mcpUrl: string,
  agentId: string,
  context: AgentContext,
): Promise<string> {
  const agent = findAgent(agentId);
  if (!agent) throw new AskAgentNotFoundError(`Unknown agent '${agentId}'`);
  return agent
    .commandBuilder()
    .addMcpServer(AGENT_MCP_SERVER_NAME, mcpUrl)
    .addInstructions(AGENT_PREAMBLE)
    .addInstructions(await describeAgentContext(api, context))
    .build();
}
