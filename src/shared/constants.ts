export const KNOWN_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    importPath: '@ai-sdk/openai',
  },
  anthropic: {
    name: 'Anthropic',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4', 'claude-haiku-4'],
    importPath: '@ai-sdk/anthropic',
  },
  google: {
    name: 'Google',
    models: ['gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    importPath: '@ai-sdk/google',
  },
} as const;

export const POPULAR_MODELS = [
  { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
  { provider: 'openai', model: 'gpt-4o-mini', label: 'GPT-4o Mini (OpenAI)' },
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Anthropic)' },
  { provider: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)' },
] as const;

export type ProviderName = keyof typeof KNOWN_PROVIDERS;
