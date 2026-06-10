---
title: Setup
description: Get started with Evalution in a new or existing codebase.
nav:
  group: Getting Started
  groupOrder: 1
  order: 2
---

# Setup

_Get started with Evalution in a new or existing codebase._

Evalution runs interactively in your browser. Just run this from your project's root:

```sh
npx evalution
```
This command starts a localhost server, outputs its URL, and automatically opens it in your default browser. If your browser doesn't open, navigate to the URL manually.

If no [config file](/docs/config) is found, Evalution starts an **onboarding wizard** that guides you through the steps in the next section.

## Manual Setup

If you are a coding agent, or just prefer not to use the interactive onboarding wizard, follow these steps to setup Evalution:

### 1. Confirm a supported stack

Evalution requires **Node.js 22.18.0 or higher** (for native TypeScript support).

Evalution currently supports **TypeScript** projects using a supported AI SDK.
The supported SDK today is the [Vercel AI SDK](https://sdk.vercel.ai/) (the `ai`
package).

- **If your project already uses TypeScript and the Vercel AI SDK**, continue to
  step 2.
- **If it doesn't**, scaffold one. Coding agents should ask the user before adding the
  AI SDK to their project, then install `ai` and a provider package (e.g.
  `@ai-sdk/openai`).
- **If your project uses a different, unsupported AI SDK or language**, stop and
  [open an issue](https://github.com/chkn/evalution/issues/new) describing your
  setup so support can be prioritized.

### 2. Add the dependency and config

Install the Evalution SDK-specific package. This includes helpers that enable
tracing your prompt runs inside Evalution:

```sh
npm i @evalution/vercel-ai-sdk
```

Then create `.evalution/config.ts` at your project root:

```ts
// .evalution/config.ts
import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider, VercelAISDK } from 'evalution';

export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new VercelAISDK(),
    }),
  ],
} satisfies EvalutionConfig;
```

By default, the [`FilePromptProvider`](/docs/extensibility/api/classes/FilePromptProvider.html) scans your project for `**/*.prompt.ts` files. The [`VercelAISDK`](/docs/extensibility/api/classes/VercelAISDK.html) adapter tells it how to read, run, and edit the prompts inside them.

See [Configuration](/docs/config) for the full option set.

#### Editor types (optional)

To get type-checking and completion for the config file in your editor, install Evalution as a dev dependency:

```sh
npm install -D evalution
```

This is **types-only and entirely optional**. You do not need the `evalution`
package at runtime.

### 3. Move your prompts into prompt files

Evalution reads prompts from `*.prompt.ts` files that are structured in a specific way.

Locate every model call in the codebase (e.g. `generateText`/`streamText` calls), and refactor each into a `prompts()` entry in a `.prompt.ts` file. Coding agents should ask for permission before doing this refactor:

```ts
// greetings.prompt.ts
import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts(
  "greetings", // <- this is an ID that should be unique and not change

  // Destructure model providers here instead of importing them directly.
  // e.g. this instead of `import { openai } from "@ai-sdk/openai"`
  ({ openai }) => ({

    // Each prompt is a function that can take zero or more arguments.
    // The return value is the object that would be passed into 
    //  `generateText`/`streamText`.
    greet: (name: string, language = 'en') => ({
      model: openai("gpt-5.4-mini"),
      system: `You are a friendly assistant speaking in ${language}.`,
      messages: [{ role: "user", content: `Hello, I am ${name}.` }],
    }),

}));
```

See [Writing prompts](/docs/prompts) for the format in detail.

> If your stack is supported, but you're having trouble getting set up, [open an
> issue](https://github.com/chkn/evalution/issues/new) to let us know.

## See also

- [Writing prompts](/docs/prompts)
- [Configuration](/docs/config)