import { describe, it, expect } from 'vitest';
import { configFileTemplate, AI_SDK_OPTIONS } from './config-template.ts';

describe('configFileTemplate', () => {
  it('imports and instantiates VercelAISDK for the Vercel AI SDK choice', () => {
    const out = configFileTemplate('vercel-ai-sdk');
    expect(out).toContain("import { FilePromptProvider, VercelAISDK } from 'evalution';");
    expect(out).toContain('sdk: new VercelAISDK()');
    expect(out).toContain('export default {');
  });

  it('exposes the Vercel AI SDK option', () => {
    expect(AI_SDK_OPTIONS.map(o => o.value)).toEqual(['vercel-ai-sdk']);
  });
});
