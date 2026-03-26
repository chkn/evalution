import { openai } from '@ai-sdk/openai';

function getSystemPrompt() {
  return 'Dynamic system prompt';
}

export function dynamicPrompt() {
  return {
    model: openai('gpt-4o'),
    system: getSystemPrompt(),
    messages: [
      { role: 'user', content: 'Test' }
    ]
  };
}
