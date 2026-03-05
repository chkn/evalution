/**
 * @packageDocumentation
 *
 * **evalution** — TypeScript AI Prompt Playground.
 *
 * This module exports the public API used to integrate evalution into your
 * own tooling or to extend it with custom prompt sources and SDK adapters.
 *
 * ### Quick start
 * ```ts
 * import { FilePromptProvider } from 'evalution';
 *
 * const provider = new FilePromptProvider({ rootDir: './prompts' });
 * const prompts = await provider.getAllPrompts();
 * ```
 */
export type { EvalutionConfig } from './config.ts';
export type { ChangeEventType, PromptProvider, PromptChangeEvent } from './providers/prompt-provider.ts';
export type { ParsedPrompt, PromptProperty, SourceSpan, ModelParameterInfo, FunctionParameter, AddPromptField, AddPromptContext, ProviderInfo } from './shared/types.ts';
export { type PromptFileType, type PromptFileParser, TSPromptFileType } from './providers/file/prompt-file-type.ts';
export { type FileProvider, type FileWatchOptions, type FileWatchCallback, type GlobOptions, LocalFileProvider, MemoryFileProvider } from './providers/file/file-provider.ts';
export type { SDKAdapter } from './server/sdk-adapter.ts';
export { VercelAISDK } from './server/sdk-adapter.ts';
export { FilePromptProvider, type FilePromptProviderOptions } from './providers/file/file-prompt-provider.ts';
export type { FilePromptMetadata, ParsedFilePrompt } from './parser/prompt-parser.ts';
