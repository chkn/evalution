
export function checkWeather() {
  return {
    model: 'openai/gpt-4o',
    system: 'You are a weather assistant',
    messages: [
      { role: 'user', content: 'What is the weather in SF?' }
    ],
    temperature: 0.7,
    maxTokens: 500
  };
}
