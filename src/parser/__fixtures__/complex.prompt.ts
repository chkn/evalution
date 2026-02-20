import { openai } from '@ai-sdk/openai';

export function complexPrompt(baseTemp: number, multiplier: number) {
  return {
    model: openai('gpt-4o-mini'),
    system: 'Complex prompt',
    messages: [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' }
    ],
    temperature: baseTemp + 0.2,
    maxTokens: 1000 * multiplier,
    topP: 0.9,
    frequencyPenalty: 0.5
  };
}
