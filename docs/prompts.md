---
title: Writing Prompts
description: Define prompts as code with the prompts() helper.
nav:
  group: Guides
  groupOrder: 2
  order: 1
---

# Writing Prompts

Evalution discovers prompts from `*.prompt.ts` files in your project. Each file
declares one or more prompts with the `prompts()` helper from
`@evalution/vercel-ai-sdk`:

```ts
// greetings.prompt.ts
import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts(
  "greetings",
  ({ openai, anthropic }) => ({

  checkWeather: () => ({
    model: openai('gpt-5.5'),
    system: 'You are a weather assistant.',
    messages: [{ role: 'user', content: 'What is the weather in SF?' }],
    temperature: 0.7,
    maxTokens: 500,
  }),

  greet: (name: string, language = 'en') => ({
    model: anthropic('claude-haiku-4-5'),
    system: `You are a friendly assistant speaking in ${language}.`,
    messages: [{ role: 'user', content: `Hello, my name is ${name}.` }],
  }),

}));
```

## The `prompts()` helper

The `prompts()` helper links each trace back to its prompt automatically: when a
prompt executes, every span it produces is tagged with the prompt's name and ID,
so runs show up against the right prompt in the **Traces** tab.

## Anatomy

`prompts(id, factory)` takes:

- **`id`** *(string, required)* — a stable, unique identifier for this group of
  prompts. Each prompt's global ID becomes `` `id#entryName` `` (e.g.
  `greetings#greet`), which is what links runtime traces back to the prompt.
- **`factory`** — a function that receives provider helpers and returns an object
  of prompts. Destructure the providers you need (`{ openai, anthropic, google }`);
  they resolve to the matching `@ai-sdk/<provider>` functions.

Each **entry** in the returned object is one prompt:

- The **key** is the prompt name (`checkWeather`, `greet` above). Computed
  string-literal keys (`["my prompt"]: () => ({ … })`) work too.
- The **value** is a function returning a Vercel AI SDK call config: `model`,
  `system`, `messages`, and any other call settings (`temperature`, `maxTokens`,
  …). This return value is passed to `generateText` when the prompt is run in
  the playground.
- **Function parameters** become the prompt's inputs. Defaults are respected —
  `greet(name, language = 'en')` exposes `name` and `language`, with `language`
  defaulting to `'en'` when you run it in the playground.

## Choosing a model

Inside an entry, set `model` either by calling a destructured provider helper or
with a gateway string:

```ts
model: openai('gpt-5.5'),        // provider function
model: 'openai/gpt-4o',          // gateway model string
```

Evalution surfaces a model picker in the UI that works with both styles, and editing the
model there writes the change back to your `.prompt.ts` file.

## File discovery

[`FilePromptProvider`](/docs/extensibility/api/classes/FilePromptProvider.html) scans for
`**/*.prompt.ts` by default, skipping `node_modules`, `dist`, and `.git`. Put prompt files
wherever they make sense alongside the code that uses them; you can customize the
include/exclude globs and root directory in [your config](/docs/config).

## See also

- [Setup](/docs/setup) — get prompts into this format from an existing codebase.
- [Configuration](/docs/config) — point the provider at your files.
