import { describe, it, expect } from 'vitest';
import { configFileTemplate, AI_SDK_OPTIONS, CONFIG_DOCS_URL } from './config-template.ts';

describe('configFileTemplate', () => {
  it('imports and instantiates VercelAISDK for the Vercel AI SDK choice', () => {
    const out = configFileTemplate('vercel-ai-sdk');
    expect(out).toContain("import { FilePromptProvider, VercelAISDK } from 'evalution';");
    expect(out).toContain('sdk: new VercelAISDK()');
    expect(out).toContain('export default config;');
  });

  it('omits a concrete SDK and points to the docs for "other"', () => {
    const out = configFileTemplate('other');
    expect(out).toContain("import { FilePromptProvider } from 'evalution';");
    expect(out).not.toContain('VercelAISDK');
    expect(out).toContain('sdk: new YourSDKAdapter()');
    expect(out).toContain(CONFIG_DOCS_URL);
  });

  it('exposes both SDK options in display order', () => {
    expect(AI_SDK_OPTIONS.map(o => o.value)).toEqual(['vercel-ai-sdk', 'other']);
  });
});
