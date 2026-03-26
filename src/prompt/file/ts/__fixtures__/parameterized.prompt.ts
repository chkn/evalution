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
