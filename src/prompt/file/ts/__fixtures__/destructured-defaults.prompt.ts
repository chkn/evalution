import { openai } from '@ai-sdk/openai';

export function customGreeting({ name, greeting = 'Hello' }: { name: string; greeting?: string }) {
  return {
    model: openai('gpt-4o'),
    system: `Say ${greeting} to ${name}`,
    messages: [
      { role: 'user', content: `${greeting}, I'm ${name}` }
    ]
  };
}
