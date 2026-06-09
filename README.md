# Evalution

**TypeScript AI Prompt Playground** - Edit and execute AI prompts with live preview.

Evalution is a local development tool that lets you create, edit, and test AI prompts using the Vercel AI SDK. Write your prompts as TypeScript functions, then use the web UI to modify parameters and see results in real-time.

## Features

- 🔍 **Auto-discovery** - Scans your project for `.prompt.ts` files
- ✏️ **Live editing** - Edit prompts in the UI, changes write back to source files
- 🔄 **Hot reload** - UI updates automatically when you edit files externally
- 🎯 **Type-safe** - Full TypeScript support with parameter inference
- 🌊 **Streaming** - Support for both streaming and non-streaming execution
- 🔌 **Multi-provider** - Works with OpenAI, Anthropic, Google, and custom providers
- 📝 **Parameterized prompts** - Define functions with parameters for dynamic prompts
- 🧪 **Playground UI** - OpenAI-style editor with model, messages, and parameter panels
- 📦 **SDK-aware parameters** - Available call settings pulled directly from your installed AI SDK

## Installation

```bash
npx evalution
```

Requires Node.js 22.18.0 or higher.

## Quick Start

1. Create a `.prompt.ts` file in your project:

```typescript
// simple.prompt.ts
import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts(
  "Simple", // <- this is an ID that should not change
  ({ openai }) => ({

  simplePrompt: () => ({
    model: openai("gpt-5.4-mini"),
    system: "You are a helpful assistant",
    messages: [{ role: "user", content: "Hello!" }],
  }),

}));
```

2. Run Evalution:

```bash
npx evalution
```

3. Open your browser to `http://localhost:3000`

4. Select your prompt, edit parameters, and execute!

## Prompt File Format

Prompts are defined as **functions** that return Vercel AI SDK configuration objects, either exported individually or grouped via the `prompts()` helper.

### Plain Exports

Each exported function is a prompt:

`simple1.prompt.ts`:
```typescript
import { openai } from '@ai-sdk/openai';

export function simplePrompt() {
  return {
    model: openai('gpt-4o'),
    system: 'You are a helpful assistant',
    messages: [{ role: 'user', content: 'Hello!' }]
  };
}
```

Then to use it:

```typescript
import { generateText } from 'ai';
import { simplePrompt } from './simple1.prompt.ts';

const prompt = simplePrompt();
const { text } = await generateText(prompt);

console.log(text);
```

### `prompts()` Helper

Alternatively, install `@evalution/vercel-ai-sdk` and use the `prompts()` helper. Provider instances are destructured from the factory parameter, and each method on the returned object is a prompt:

`simple2.prompt.ts`:
```typescript
import { prompts } from '@evalution/vercel-ai-sdk';

export default prompts(({ openai }) => ({

  simplePrompt() {
    return {
      model: openai('gpt-4o'),
      system: 'You are a helpful assistant',
      messages: [{ role: 'user', content: 'Hello!' }],
    };
  },

}));
```

This form allows you to override the default provider instance (if you don't override it, you get the default instance, just like in the previous section). Here's an example:

```typescript
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import prompts from './simple2.prompt.ts';

const { simplePrompt } = prompts({
  openai: createOpenAI({ apiKey: "XXX" })
});
const prompt = simplePrompt();
const { text } = await generateText(prompt);

console.log(text);
```

**Use the helper if:**
- You need to override the default provider instance.
- You want your prompt functions to be strongly typed against the AI SDK's config shape without writing your own type annotations.

**Don't use the helper if:**
- You don't want to add a runtime dependency on `@evalution/vercel-ai-sdk`.

### Parameterized Prompts

In either form, prompt functions can accept parameters used in the configuration:

```typescript
import { openai } from '@ai-sdk/openai';

export function greet(name: string, language = 'en') {
  return {
    model: openai('gpt-4o'),
    system: `You are a friendly assistant speaking in ${language}`,
    messages: [
      { role: 'user', content: `Hello, my name is ${name}` }
    ],
    temperature: 0.7
  };
}
```

When executing this prompt in the UI, you'll be prompted to provide values for `name` and `language`.

## Model Configuration

Two formats are supported:

### String Format

Using a bare string for the `model` results in using the [global provider](https://ai-sdk.dev/docs/ai-sdk-core/provider-management#global-provider-configuration).

For example, if you're using the Vercel AI Gateway, which is the default global provider:

```typescript
model: 'openai/gpt-5.2-chat'
model: 'anthropic/claude-sonnet-4.6'
model: 'google/gemini-3-pro-preview'
```

### Provider Format

You can also import a provider and use it:

```typescript
import { openai } from '@ai-sdk/openai';

model: openai('gpt-5.2-chat')
```

The UI allows you to switch between formats and select from popular models.

## Environment Variables

To test your prompts in the UI, set the applicable API keys for the providers you are using:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
```

## File Watching

Evalution automatically watches your `.prompt.ts` files. When you edit a file externally, the UI refreshes to show your changes.

## Extensibility

Evalution uses a provider abstraction for loading prompts. The default `FileSystemPromptProvider` loads prompts from `.prompt.ts` files, but you can create custom providers to load prompts from databases, APIs, or other sources.

See `src/providers/prompt-provider.ts` for the interface.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build
npm run build

# Dev mode (client only)
npm run dev
```

## How It Works

1. **Scanning**: Evalution scans your project for `**/*.prompt.ts` and `**/*.promp.ts` files
2. **Parsing**: TypeScript AST parser extracts exported functions and their configurations
3. **Server**: Hono serves the web UI and API endpoints
4. **Editing**: When you edit in the UI, changes are written back to source files using precise character-range replacement. Adding or removing parameters updates the source file automatically.
5. **Parameters**: Available call settings are read at startup from the `CallSettings` type in your locally installed `ai` package, so the list always reflects your SDK version. JSDoc descriptions are extracted and shown in the UI.
6. **Execution**: Node's native TypeScript support dynamically imports your prompt files and calls the functions with provided parameters
7. **AI SDK**: The returned configuration is passed directly to Vercel AI SDK's `generateText()` or `streamText()`

## Architecture

- **Parser**: TypeScript Compiler API for AST parsing and call settings introspection
- **Editor**: Character-range replacement preserving formatting, with add/remove support
- **Server**: Hono with SSE for hot reload
- **Client**: React playground UI with SSE for real-time updates
- **Build**: tsdown for server, Vite for client

## License

AGPL

## Contributing

Contributions welcome! Please open an issue or PR.

## Troubleshooting

**No prompts found**
- Make sure your files end with `.prompt.ts`
- Files must either export functions directly, or default-export a `prompts(...)` helper call

**API key errors**
- Ensure you've set the correct environment variables
- Check that API keys are valid

**TypeScript errors**
- Evalution requires Node.js 22.18.0+ with native TS support
- If using tsx/ts-node, configure accordingly

**Hot reload not working**
- Check browser console for SSE connection errors
- Ensure file watcher has permissions
