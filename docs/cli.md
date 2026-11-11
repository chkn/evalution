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
npx evalution [ui [path]] [--host <address>]
npx evalution mcp [path]
npx evalution link [path]
```

- `evalution` — start the playground for the current directory.
- `evalution ui` — same as above.
- `evalution ui <path>` — start for `<path>` instead of the current directory.
- `evalution ui --host <address>` — listen on `<address>` instead of
  `127.0.0.1`. See [Network access](#network-access).
- `evalution mcp` — serve the project as an MCP server over stdio. See [MCP server](#mcp-server).
- `evalution mcp <path>` — same, for `<path>` instead of the current directory.
- `evalution link` — link the project to Evalution Cloud. See [Project URL](#project-url).

## How a project is found

From the starting directory (the current directory, or `<path>` if given),
Evalution walks **up** the directory tree looking for a `.evalution/config.ts`
file. The first directory that contains one becomes the project root, and its
config is loaded.

If no `.evalution/config.ts` is found anywhere up the tree, Evalution starts in
**onboarding mode** and guides you through creating one. See [Configuration](/docs/config) for the config file format.

On startup Evalution opens the playground in your default browser automatically.

## Network access

By default, the playground listens on `127.0.0.1` (IPv4 loopback) only, so it can't be
reached from other machines.

To use the playground on a remote machine, forward its port (3000 by default - see [`PORT`](#environment))
over SSH rather than exposing it:

```sh
ssh -L 3000:127.0.0.1:3000 devbox
```

VS Code Remote, Codespaces, and similar tools forward ports the same way, so they should work too.

`--host` changes the address the playground listens on:

| Address | Reachable from |
| --- | --- |
| `127.0.0.1` (default) | This machine only (IPv4). |
| `::1` | This machine only, over IPv6. |
| `0.0.0.0` / `::` | Every network interface: the LAN, and anything else that can route to this machine. |
| A specific address, e.g. `192.168.1.5` | That interface's network. |

⚠️ **Listen beyond loopback only on a network you trust**: the server has no
authentication (see [Security](#security)). Inside a container, `--host 0.0.0.0`
is needed for a published port (`docker run -p 3000:3000 …`) to reach it.

Whatever it listens on, the server only answers requests addressed to
`localhost`, a `*.localhost` name, an IP address, or the name given to `--host`
(e.g. `--host devbox.local`). So with `--host 0.0.0.0`, open it by IP address
rather than by a name like `devbox.local` (see [Security](#security) for why).

`evalution mcp` takes no `--host`: the process holding a project listens on a
random `127.0.0.1` port, only for the `evalution mcp`s relaying to it.

### HTTPS with portless

For the most security and best experience, we recommend using [portless](https://portless.sh),
which gives each project's playground a stable HTTPS URL, such as `https://evalution.myapp.localhost`.

1. Install portless globally: `npm install -g portless`
2. Run Evalution through it: `portless run --name evalution.myapp npx evalution`

See the [portless docs](https://portless.sh/configuration) for how to configure it to launch
more ergonomically.

Why use portless:

- **Projects stay apart.** Each project's playground has its own URL, and the browser
  keeps each one's saved view settings separately.
- **The URL doesn't change** when the port does.
- **HTTP/2**, so the playground's live connections (one per open trace)
  don't run into the browser's limit of six per HTTP/1.1 host.

Note that sharing a playground through portless's `--tailscale` or `--ngrok` options isn't
supported.

### HTTPS with portkit

If portkit is installed, Evalution registers itself with it on
start, as `<directory>.evalution`, and opens the playground at
`https://<directory>.evalution.localhost`. The registration lasts as long as the server runs. If
portkit isn't installed or refuses the name, Evalution starts as usual on its local port.

## Project URL

With Evalution Cloud, a project gets one URL,
`https://<project>--<org>.local.evalut.io`, that opens **each member's own
running playground**. A link to a trace sent to someone else opens that trace
in their copy of the project.

1. Create a personal API key at [evalut.io/cloud](https://evalut.io/cloud) and
   set it as `EVALUTION_API_KEY`, in your shell profile or the project's `.env`.
2. Run `npx evalution link` once per repo. It asks which of your cloud
   projects to link (or creates one) and adds its id to `.evalution/config.ts`:

   ```ts
   export default {
     cloud: { project: "prj_…" },
     // …
   } satisfies EvalutionConfig;
   ```

   Commit it. The id isn't a secret: only the project's members can use it.
   If there's no config yet, set the project up with `npx evalution` first.

From then on, a playground started with a personal key registers with the cloud
while it runs and prints the project URL. **Copy link** on a trace copies a link
to it by that URL. Opening the URL sends you to your running playground on that
machine. The browser the playground opens in on start is remembered as being on
that machine, so the URL goes straight there. Any other browser asks once which of
your running playgrounds is on this machine, and remembers the answer.

With [portkit](#https-with-portkit) there's nothing to ask: if every running
copy is served at the same portkit name (the same directory name on each machine),
the URL goes straight to `https://<directory>.evalution.localhost`, which is always
this machine's copy. If it's set up to start on demand, visiting the link starts it.

The cloud only ever sends a browser to a loopback address (`localhost`,
`*.localhost`, `127.0.0.1`, `[::1]`), so a playground started with
`--host` naming another interface doesn't register.

## Sending traces from your app

The `Evalution` client from `@evalution/sdk` sends your app's traces. Integrations use one
configured from the environment unless you pass your own:

```ts
import { registerTelemetry } from "ai";
import { VercelAISDKTelemetry } from "@evalution/vercel-ai-sdk";

registerTelemetry(new VercelAISDKTelemetry());
```

It picks one destination, the first time a trace is sent:

1. The `endpoint` passed to `new Evalution({ ... })`, or nowhere if it's `false`.
2. The cloud, if the API key (the `apiKey` option or `EVALUTION_API_KEY`) is an ingest key
   (`evl_ingest_…`).
3. The local instance at `EVALUTION_ENDPOINT`.
4. On Node, the instance portkit is running for this directory or a parent of it.
5. Nowhere: tracing does nothing.

A personal key (`evl_user_…`) never sends traces to the cloud, so with one set your development
traces still go to your local instance. Before a script or serverless function exits, `await` the
integration's `flush()` so no traces are lost.

## MCP server

`evalution mcp` lets a coding agent work with your prompts, traces, datasets,
and evals directly. Register it with your agent as a stdio server, run from the
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
- **Evals** — list the checks an eval can use (`list_checks`); create, read,
  change, and delete evals (`create_eval`, `get_eval`, `update_eval`,
  `delete_eval`, `list_evals`), with parameters bound to dataset columns by
  name — and, by default, to the columns that match them, as the eval editor
  does. Start a run without waiting for it (`start_eval_run`), follow it and
  read its results — per-arm pass rates, each row's check outcomes, and the
  trace each row recorded (`get_eval_run`, `list_eval_runs`) — and cancel or
  delete runs (`cancel_eval_run`, `delete_eval_run`).

A SQL query that runs longer than 10 seconds is stopped with an error.

A project's databases can only be open in one process at a time, so the first
evalution process to serve a project holds them, and every `evalution mcp`
started after it relays to that one instead. Several agent sessions on one
project can therefore run side by side. When the playground (`evalution ui`)
is that first process, annotations agents leave show up in it live. The
playground also serves MCP itself, over HTTP at `/mcp` — e.g.
`claude mcp add --transport http evalution http://localhost:3000/mcp`.

When the process holding the project goes away (its agent session ended, or
the playground was stopped), the other `evalution mcp`s carry on without
their agents noticing: one of them takes the project over, and the rest relay
to it. An `evalution mcp` whose agent session ends keeps running until the
eval runs it holds have finished.

Start the playground before your agents when you use both: while an agent's
`evalution mcp` holds the project, `evalution ui` can't start, and says so.

## Environment

| Variable | Effect |
| --- | --- |
| `PORT` | Port for the local server. When set, it's used as-is. When unset, Evalution uses `3000`, falling back to the next free port if it's already taken. |
| `EVALUTION_NO_OPEN` | When set to any value, Evalution does **not** open the playground in your browser on start — useful for CI and remote or headless hosts. |
| `EVALUTION_ENDPOINT` | In your app: the base URL of a local Evalution instance to send traces to. See [Sending traces from your app](#sending-traces-from-your-app). |
| `EVALUTION_API_KEY` | In your app: an ingest key sends its traces to Evalution Cloud. For the playground and `evalution link`: a personal key links the project to Evalution Cloud. See [Project URL](#project-url). |
| `EVALUTION_API_URL` | Replaces `https://api.evalut.io` as the cloud's address, e.g. for staging. |
| `EVALUTION_NO_COST_ESTIMATES` | By default, the first time a trace records an LLM call with token usage, Evalution downloads model prices from Vercel AI Gateway's public catalog (`https://ai-gateway.vercel.sh/v1/models`), or from OpenRouter's (`https://openrouter.ai/api/v1/models`) if that fails, to show estimated costs. When set to any value, those requests are never made and traces show no costs — useful for offline or air-gapped hosts. |

### Provider API keys

To run prompts in the playground, set the applicable API key environment variable for each AI provider you use, for example:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

If an `.env` file is found in the project root, it is loaded automatically before the server starts. This is the recommended place to keep these keys. Do not commit it to version control.

## Security

Evalution is a local development tool. Its server has **no authentication**:
anything that can connect to it can do what you can do in the playground.
Bear this in mind before listening beyond loopback, or using it on a machine other
people can log in to, since loopback addresses are shared by every user on a
machine.

### What the server exposes

Anything that can reach the playground's port can:

- **Read the project**: every prompt and its source, every trace (which records
  your app's real LLM inputs and outputs), dataset, eval, and eval result.
- **Change the project**: edit and rename prompts (which writes to their
  source files), create and delete datasets, rows, evals, eval runs, traces,
  and annotations, and create `.evalution/config.ts` if it doesn't exist.
- **Spend your API keys**: run prompts and evals with the provider keys in the
  server's environment.
- **Add traces**: `POST /v1/traces` (and `/otel/v1/traces`) accepts OTLP
  exports, and `POST /api/traces` the traces an SDK adapter sends, from
  any sender, so traces in the playground aren't necessarily from your app.
- **Run commands**: the interactive terminal (`/api/terminal`) runs
  onboarding's commands (package installs, coding agent CLIs) and launches
  Claude Code or Codex in the project, forwarding keystrokes to them. That
  makes it equivalent to a shell in the project, with your account's
  permissions.

The `/mcp` endpoint offers the same reads, changes, and prompt and eval runs
as MCP tools (listed under [MCP server](#mcp-server)). Trace queries are
read-only SQL, stopped after 10 seconds.

`evalution mcp` exposes only `/mcp` (and the `/api/config` its relays check),
on a loopback port.

### Protections

- **Loopback by default.** Neither server listens beyond `127.0.0.1` unless you
  pass `--host`.
- **The terminal runs only commands the server defines.** The browser names
  an onboarding step, or an agent and what you're viewing; the server
  builds the command line itself, quoting every argument. So the client
  can't supply an arbitrary command or inject text into an agent's initial
  instructions, but it can subsequently send arbitrary keystrokes to it.
- **Other websites are refused.** Both servers answer 403 to every request,
  WebSocket handshakes included, unless:
  - its `Host` is `localhost`, a `*.localhost` name (which only resolves to
    loopback), an IP address, the name given to `--host`, or portless's or portkit's URL;
    and
  - if it has an `Origin` (a browser sent it on a page's behalf), that page
    is on a loopback host, on one of those names, or on the host the request
    is addressed to.

These checks stop other web pages in a browser, not other programs on the same
machine. Anything that can connect to the port directly can leave `Origin` out
and use the whole API, terminal included.

### Agents and untrusted data

A coding agent connected to evalution's MCP server, whether through
`evalution mcp` or the "Ask AI" button, reads traces and dataset rows. Treat
them as untrusted input: a trace records whatever your app's users sent, and
text in it can try to give the agent instructions (prompt injection). Review
what an agent proposes to do with your project as you would with any other
input it reads.
