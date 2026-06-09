---
title: Setup
description: Add evalution to a TypeScript project and refactor your prompts into the playground.
nav:
  group: Getting Started
  groupOrder: 1
  order: 2
---

# Setup

Evalution can work with a new or existing codebase. You shouldn't normally
install the Evalution package as a dependency. Instead, just run it with `npx`
from your project's root:

```sh
npx evalution
```

If no [config file](/docs/config) is found, Evalution starts an **onboarding
wizard** that guides you through the following steps.

## 1. Confirm a supported stack

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

## 2. Add the dependency and config

Install the Evalution AI SDK-specific package. This includes helpers that enable
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

By default, [`FilePromptProvider`](/docs/extensibility/api/classes/FilePromptProvider.html) scans
your project for `**/*.prompt.ts` files. The [`VercelAISDK`](/docs/extensibility/api/classes/VercelAISDK.html)
adapter tells it how to read, run, and edit the prompts inside them using the Vercel AI SDK.
See [Configuration](/docs/config) for the full option set.

### Editor types (optional)

To get type-checking and completion for the config file in your editor, install Evalution as a dev dependency:

```sh
npm install -D evalution
```

This is **types-only and entirely optional**. You do not need the `evalution`
package at runtime.

## 3. Move your prompts into prompt files

Evalution reads prompts from `*.prompt.ts` files that use the `prompts()` helper.

Locate every model call in the codebase (e.g. `generateText`/`streamText` calls),
and refactor each into a `prompts()` entry in a `.prompt.ts` file.
Coding agents should ask for permission before doing this refactor.

See [Writing prompts](/docs/prompts) for the format in detail.

```ts
// greetings.prompt.ts
import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts(
  "greetings", // <- this is an ID that should be unique and not change
  ({ openai }) => ({

  // Each prompt is a function that can take zero or more arguments.
  // The return value is the object that would be passed into 
  //  `generateText`/`streamText`.
  greet: (name: string) => ({
    model: openai('gpt-5.5'),
    system: 'You are a friendly assistant.',
    messages: [{ role: 'user', content: `Say hello to ${name}.` }],
  }),

}));
```

> If your stack is supported, but you're having trouble getting set up, [open an
> issue](https://github.com/chkn/evalution/issues/new) to let us know.

## See also

- [Writing prompts](/docs/prompts)
- [Configuration](/docs/config)