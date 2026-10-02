---
title: CLI
description: Command-line reference for the evalution CLI.
nav:
  group: Reference
  groupOrder: 3
  order: 1
---

# CLI

Evalution's CLI starts the local playground, or serves the same project to a
coding agent over [MCP](https://modelcontextprotocol.io).

## Usage

```sh
npx evalution [ui [path]]
npx evalution mcp [path]
```

- `evalution` — start the playground for the current directory.
- `evalution ui` — same as above.
- `evalution ui <path>` — start for `<path>` instead of the current directory.
- `evalution mcp` — serve the project as an MCP server over stdio. See [MCP server](#mcp-server).
- `evalution mcp <path>` — same, for `<path>` instead of the current directory.

## How a project is found

From the starting directory (the current directory, or `<path>` if given),
Evalution walks **up** the directory tree looking for a `.evalution/config.ts`
file. The first directory that contains one becomes the project root, and its
config is loaded.

If no `.evalution/config.ts` is found anywhere up the tree, Evalution starts in
**onboarding mode** and guides you through creating one. See [Configuration](/docs/config) for the config file format.

On startup Evalution opens the playground in your default browser automatically.

## MCP server

`evalution mcp` lets a coding agent work with your prompts, traces, and
datasets directly. Register it with your agent as a stdio server, run from the
project root. For Claude Code:

```sh
claude mcp add evalution -- npx evalution mcp
```

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.evalution]
command = "npx"
args = ["evalution", "mcp"]
```

Any other MCP client takes the same command: `npx evalution mcp`.

The server offers tools to:

- **Prompts** — list every prompt with the file it's defined in, its model, and
  its parameters (`list_prompts`, `get_prompt`), and run one with plain JSON
  arguments, waiting for its output (`execute_prompt`).
- **Traces** — list traces (`list_traces`), query them with read-only SQL
  (`query_traces`, with the schema from `get_trace_schema` or the
  `evalution://trace-providers/<id>/schema` resource), and fetch traces in full
  with every span and annotation (`get_traces`).
- **Annotations** — list, create, edit, and delete the notes on a trace or span
  (`list_annotations`, `create_annotation`, `update_annotation`,
  `delete_annotation`). They show up live in the playground.
- **Datasets** — create (optionally from a prompt's parameters), rename, and
  delete datasets; add, rename, and delete fields; add, update, list, and delete
  rows in bulk, by field name; and query rows with read-only SQL against a
  `rows` view with a column per field (`query_dataset_rows`).

A SQL query that runs longer than 10 seconds is stopped with an error.

A project's databases can only be open in one process at a time, so the first
evalution process to serve a project holds them, and every `evalution mcp`
started after it relays to that one instead. Several agent sessions on one
project can therefore run side by side. When the playground (`evalution ui`)
is that first process, annotations agents leave show up in it live. The
playground also serves MCP itself, over HTTP at `/mcp` — e.g.
`claude mcp add --transport http evalution http://localhost:3000/mcp`.

Start the playground before your agents when you use both: while an agent's
`evalution mcp` holds the project, `evalution ui` can't start, and says so.

## Environment

| Variable | Effect |
| --- | --- |
| `PORT` | Port for the local server. When set, it's used as-is. When unset, Evalution uses `3000`, falling back to the next free port if it's already taken. |
| `EVALUTION_NO_OPEN` | When set to any value, Evalution does **not** open the playground in your browser on start — useful for CI and remote or headless hosts. |
| `EVALUTION_NO_COST_ESTIMATES` | By default, the first time a trace records an LLM call with token usage, Evalution downloads model prices from OpenRouter's public catalog (`https://openrouter.ai/api/v1/models`) to show estimated costs. When set to any value, that request is never made and traces show no costs — useful for offline or air-gapped hosts. |

### Provider API keys

To run prompts in the playground, set the applicable API key environment variable for each AI provider you use, for example:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

If an `.env` file is found in the project root, it is loaded automatically before the server starts. This is the recommended place to keep these keys. Do not commit it to version control.
