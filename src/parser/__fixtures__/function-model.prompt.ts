import { openai } from '@ai-sdk/openai';

export function simplePrompt() {
  return {
    model: openai('gpt-4o'),
    system: 'You are a helpful assistant',
    messages: [
      { role: 'user', content: 'Hello!' }
    ]
  };
}
