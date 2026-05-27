import { prompts } from '@evalution/vercel-ai-sdk';

export default prompts(({ openai, anthropic }) => ({
  checkWeather() {
    return {
      model: openai('gpt-4o'),
      system: 'You are a weather assistant',
      messages: [
        { role: 'user', content: 'What is the weather in SF?' }
      ],
      temperature: 0.7,
      maxTokens: 500,
    };
  },
  greet(name: string, language = 'en') {
    return {
      model: anthropic("claude-haiku-4-5"),
      system: `You are a friendly assistant speaking in ${language}`,
      messages: [
        { role: 'user', content: `Hello, my name is ${name}` }
      ],
    };
  },
}));
