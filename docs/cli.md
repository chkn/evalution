---
title: CLI
description: Command-line reference for the evalution CLI.
nav:
  group: Reference
  groupOrder: 3
  order: 1
---

# CLI

Evalution ships a single command that starts the local playground.

## Usage

```sh
npx evalution [ui [path]]
```

- `evalution` — start the playground for the current directory.
- `evalution ui` — same as above; `ui` is currently the only named subcommand.
- `evalution ui <path>` — start for `<path>` instead of the current directory.

## How a project is found

From the starting directory (the current directory, or `<path>` if given),
Evalution walks **up** the directory tree looking for a `.evalution/config.ts`
file. The first directory that contains one becomes the project root, and its
config is loaded.

If no `.evalution/config.ts` is found anywhere up the tree, Evalution starts in
**onboarding mode** and guides you through creating one. See [Configuration](/docs/config) for the config file format.

On startup Evalution opens the playground in your default browser automatically.

## Environment

| Variable | Effect |
| --- | --- |
| `PORT` | Port for the local server. When set, it's used as-is. When unset, Evalution uses `3000`, falling back to the next free port if it's already taken. |
| `EVALUTION_NO_OPEN` | When set to any value, Evalution does **not** open the playground in your browser on start — useful for CI and remote or headless hosts. |

### Provider API keys

To run prompts in the playground, set the applicable API key environment variable for each AI provider you use, for example:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

If an `.env` file is found in the project root, it is loaded automatically before the server starts. This is the recommended place to keep these keys. Do not commit it to version control.
