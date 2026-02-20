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

## Installation

```bash
npx evalution
```

Requires Node.js 22.18.0 or higher.

## Quick Start

1. Create a `.prompt.ts` file in your project:

```typescript
// weather.prompt.ts
import { openai } from '@ai-sdk/openai';

export function checkWeather() {
  return {
    model: openai('gpt-4o'),
    system: 'You are a weather assistant',
    messages: [
      { role: 'user', content: 'What is the weather in San Francisco?' }
    ],
    temperature: 0.7,
    maxTokens: 500
  };
}
```

2. Run Evalution:

```bash
npx evalution
```

3. Open your browser to `http://localhost:3000`

4. Select your prompt, edit parameters, and execute!

## Prompt File Format

Prompts are defined as **exported functions** that return Vercel AI SDK configuration objects.

### Simple Prompt (No Parameters)

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

### Parameterized Prompt

Functions can accept parameters that are used in the prompt configuration:

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

```typescript
model: 'openai/gpt-4o'
model: 'anthropic/claude-sonnet-4-20250514'
model: 'google/gemini-2.5-flash'
```

### Function Call Format

```typescript
import { openai } from '@ai-sdk/openai';

model: openai('gpt-4o')
```

The UI allows you to switch between formats and select from popular models.

## Supported Parameters

All Vercel AI SDK parameters are supported:

- `model` - AI model (required)
- `messages` - Conversation messages (required)
- `system` - System prompt
- `temperature` - Randomness (0-2)
- `maxTokens` - Max output tokens
- `topP` - Nucleus sampling
- `frequencyPenalty` - Reduce repetition
- `presencePenalty` - Encourage new topics
- `tools` - Tool definitions
- `maxSteps` - For agentic behavior

## Environment Variables

Set API keys for the providers you want to use:

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
3. **Server**: Fastify serves the web UI and API endpoints
4. **Editing**: When you edit in the UI, changes are written back to source files using precise character-range replacement
5. **Execution**: Node's native TypeScript support dynamically imports your prompt files and calls the functions with provided parameters
6. **AI SDK**: The returned configuration is passed directly to Vercel AI SDK's `generateText()` or `streamText()`

## Architecture

- **Parser**: TypeScript Compiler API for AST parsing
- **Editor**: Character-range replacement preserving formatting
- **Server**: Fastify with WebSocket support for hot reload
- **Client**: React with Server-Sent Events for real-time updates
- **Build**: tsup for server, Vite for client

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Troubleshooting

**No prompts found**
- Make sure your files end with `.prompt.ts`
- Files must export functions (not default exports or const objects)

**API key errors**
- Ensure you've set the correct environment variables
- Check that API keys are valid

**TypeScript errors**
- Evalution requires Node.js 22.18.0+ with native TS support
- If using tsx/ts-node, configure accordingly

**Hot reload not working**
- Check browser console for SSE connection errors
- Ensure file watcher has permissions
