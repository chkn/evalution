---
title: CLI
description: Command-line reference for the evalution CLI.
nav:
  group: Reference
  groupOrder: 3
  order: 1
---

# CLI

Evalution ships a single command that starts the local playground. Run it with
`npx` (no install required) or from a project that depends on `evalution`:

```sh
npx evalution
```

## Usage

```
evalution [ui [path]]
```

- `evalution` — start the playground for the current directory.
- `evalution ui` — same as above; `ui` is currently the only named subcommand.
- `evalution ui <path>` — start for `<path>` (resolved relative to the current
  working directory) instead of the current directory.

## How a project is found

From the starting directory (the current directory, or `<path>` if given),
Evalution walks **up** the directory tree looking for a `.evalution/config.ts`
file. The first directory that contains one becomes the project root, and its
config is loaded.

If no `.evalution/config.ts` is found anywhere up the tree, Evalution starts in
**onboarding mode** and guides you through creating one.

See [Configuration](/docs/config) for the config file format.

## Environment

| Variable | Effect |
| --- | --- |
| `PORT` | Port for the local server. Defaults to `3000`. |

### .env

A `.env` file in the project root is loaded automatically before the server
starts, unless the config sets [`useDotenv: false`](/docs/extensibility/api/interfaces/EvalutionConfig.html#usedotenv).
This is the recommended place to put the API keys for any AI providers you run
prompts against (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`GOOGLE_GENERATIVE_AI_API_KEY`), so they're available to the SDK adapters when
you run prompts in Evalution.
