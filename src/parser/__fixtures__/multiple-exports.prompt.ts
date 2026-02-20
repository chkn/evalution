import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

export function promptOne() {
  return {
    model: openai('gpt-4o'),
    system: 'First prompt',
    messages: [{ role: 'user', content: 'Test 1' }]
  };
}

export function promptTwo() {
  return {
    model: anthropic('claude-sonnet-4-20250514'),
    system: 'Second prompt',
    messages: [{ role: 'user', content: 'Test 2' }]
  };
}
