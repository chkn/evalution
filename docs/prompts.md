---
title: Prompts
description: Learn how to define prompts in your codebase.
nav:
  group: Guides
  groupOrder: 2
  order: 1
---

# Prompts

Prompts are stored as regular source files in your codebase. Evalution can load prompt source files and edit them directly.

[`FilePromptProvider`](/docs/extensibility/api/classes/FilePromptProvider.html) scans for files with a  `.prompt.ts` extension by default, skipping `node_modules`, `dist`, and `.git` directories. Put prompt files wherever they make sense alongside the code that uses them. You can customize the include/exclude globs and root directory in [your config](/docs/config).

## The `prompts()` helper

Evalution provides a runtime package for each supported AI SDK: `@evalution/vercel-ai-sdk` for the Vercel AI SDK, and `@evalution/typesafe-sdk` for TypeSafe (see [below](#typesafe-system-one-prompts)). The package exports a `prompts` function that serves as a helper for defining prompts that integrate with Evalution.

Using the helper brings these benefits:
- Type safety
- Transparent linking between prompts and traces
- Decoupling of prompts from how providers are instantiated

```ts
// assistant.prompt.ts
import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts(
  { id: "assistant" }, // <- this ID should be unique and not change

  // Destructure model providers here instead of importing them directly.
  ({ openai, anthropic }) => ({

    greet: (name: string, language = "en") => ({
      model: anthropic("claude-haiku-4-5"),
      system: `You are a friendly assistant speaking in ${language}.`,
      messages: [{ role: "user", content: `Hello, I am ${name}.` }],
    }),

    ["check weather in SF"]: () => ({
      model: openai("gpt-5.5"),
      system: "You are a weather assistant.",
      messages: [{ role: "user", content: "What is the weather in SF?" }],
      temperature: 0.7,
      maxTokens: 500,
    }),
}));
```

### Anatomy

`prompts({ id }, factory)` takes:

- **`{ id }`** *(object, required)* — an object containing a single `id` key,
  whose value should be a stable, unique identifier for this group of
  prompts. Each prompt's global ID becomes `` `id#entryName` `` (e.g.
  `assistant#greet`), which is what links runtime traces back to the prompt.
  This ensures the link is not broken if prompt files are moved or renamed.
- **`factory`** — a function that receives provider functions and returns an object
  of prompts. Destructure the providers you need (`{ openai, anthropic, google }`);
  they resolve to the matching `@ai-sdk/<provider>` functions.

Each **entry** in the returned object is one prompt:

- The **key** is the prompt name (`greet`, `check weather in SF` in the example above).
- The **value** is a function returning a Vercel AI SDK call config object. This
  returned object is passed to `generateText` when the prompt is run in the playground.
- **Function parameters** become the prompt's inputs. In the above example,
  `greet` exposes 2 inputs: `name` and `language`, with `language` defaulting to `"en"`.

### Running prompts

To use prompts declared with the helper, first import the prompt factory from your prompt file. This is a function that accepts an optional object where you can pass AI SDK providers you have created. The result of that function is the object containing your prompt functions that you returned from the second parameter to the helper.

```ts
import prompts from "./assistant.prompt.ts";

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

const anthropic = createAnthropic({ apiKey: "..." });
const { greet } = prompts({ anthropic });

const prompt = greet("Sally");
const result = await generateText(prompt);
```

If you do not pass a provider instance to the `prompts` factory, it will use the default provider exports, as though you'd passed `anthropic` from `import { anthropic } from "@ai-sdk/anthropic"`.

## Bare function exports

You don't have to use the helper. Evalution also discovers plain exported functions that return a Vercel AI SDK config. The name of the function is the name of the prompt, and just like the previous form, function parameters are prompt inputs:

```ts
import { anthropic } from "@ai-sdk/anthropic";

export function greet(name: string, language = "en") {
  return {
      model: anthropic("claude-haiku-4-5"),
      system: `You are a friendly assistant speaking in ${language}.`,
      messages: [{ role: "user", content: `Hello, my name is ${name}.` }],
  };
}
```

This form requires no runtime dependency on any Evalution package, but carries some disadvantages:
- Only traces for runs started from the Evalution playground will link back to their prompts.
- Prompts have no stable global ID, meaning that moving or renaming the file will break links to any previously recorded traces.
- Unless you use a manual side channel, prompts use default provider instances, which usually expect API keys to be in environment variables. This may not be compatible with some runtime environments (e.g. Cloudflare workers).

If you don't mind the runtime dependency, you can manually provide a global ID to enable linking runtime traces back to prompts by calling [`createTracerForPrompt`](/docs/extensibility/api/functions/createTracerForPrompt.html):

```ts
import { anthropic } from "@ai-sdk/anthropic";

import { createTracerForPrompt } from "@evalution/vercel-ai-sdk";

export function greet(name: string, language = "en") {
  return {
      model: anthropic("claude-haiku-4-5"),
      system: `You are a friendly assistant speaking in ${language}.`,
      messages: [{ role: "user", content: `Hello, my name is ${name}.` }],
      experimental_telemetry: {
        isEnabled: true,
        tracer: createTracerForPrompt({ name: "greet", id: "globally-unique-id" })
      }
  };
}
```



## Which form should I use?

Generally, the `prompts()` helper is recommended, however both forms are supported. This table illustrates the tradeoffs:

|                              | `prompts()` helper             | Bare exports          |
| ---------------------------- | ------------------------------ | --------------------- |
| Runtime dependency           | `@evalution/vercel-ai-sdk`     | optional              |
| Provider instances           | consumer determines            | prompt determines     |
| Trace linking                | automatic                      | manual                |
| Stable global ID             | automatic                      | manual                |
| Return types                 | typed against the AI SDK       | annotate it yourself  |

## TypeSafe System One prompts

A [TypeSafe](https://docs.typesafe.ai/) System One model answers a set of named, typed questions about a *state* instead of continuing a conversation. Its prompts use the same shape, with `@evalution/typesafe-sdk`'s `prompts()` helper:

```ts
// triage.prompt.ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { prompts } from "@evalution/typesafe-sdk";

type Ticket = { subject: string; body: string };

export default prompts({ id: "support-triage" }, () => ({
  triage: (ticket: Ticket, product: string) => ({
    state: { ticket },
    questions: {
      refund_requested: noul(`Does the customer ask for a refund for ${product}?`),
      team: choice("Which team should handle this?", {
        billing: "Payments and refunds",
        technical: null,
      }),
      frustration: score("How frustrated is the customer?", ["Calm", "Frustrated", "Very angry"]),
    },
  }),
}));
```

Use a `type` alias rather than an `interface` for data you put in the state: the SDK types state as JSON, and TypeScript only checks an alias's properties against that.

Configure the provider with `sdk: new TypeSafeSDK()`, and set `TYPESAFE_API_KEY` to run prompts. The playground edits the state and the questions directly — each question through the SDK's own question types, with `${…}` completion from the prompt's parameters — and shows each run's answers as charts.

At run time, wrap your client with `instrument()` so calls made with these prompts are traced and linked back to them. Answer types are still inferred from each prompt's questions:

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { instrument } from "@evalution/typesafe-sdk";
import triagePrompts from "./triage.prompt.ts";

const client = instrument(new TypeSafeClient());
const { answers } = await client.systemOne(triagePrompts().triage(ticket, "Pro plan"));
answers.team.choice; // "billing" | "technical"
```

## See also

- [Setup](/docs/setup) — get prompts into this format from an existing codebase.
- [Configuration](/docs/config) — point the provider at your files.
