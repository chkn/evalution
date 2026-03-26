import { openai } from '@ai-sdk/openai';

export function broken() {
  return {
    model: openai('gpt-4o'),
    system: 'This has a syntax error
  };
}
