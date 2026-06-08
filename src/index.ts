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
export type { PromptProvider } from './prompt/prompt-provider.ts';
export type { TraceProvider } from './trace/trace-provider.ts';
export {
  createTracerForPrompt,
  SPAN_KIND_ATTRIBUTE,
  PROMPT_PROVIDER_ID_ATTRIBUTE,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
} from './trace/prompt-tracer.ts';
export { MemoryTraceProvider } from './trace/memory-trace-provider.ts';
export type {
  ChangeEventType,
  PromptChangeEvent,
  ParsedPrompt,
  NormalizedPrompt,
  NormalizedMessage,
  NormalizedToolCall,
  NormalizedParameter,
  NormalizedPromptUpdates,
  SourceSpan,
  ModelValueType,
  ModelInfo,
  ModelCatalog,
  ModelGroupInfo,
  ModelPropValue,
  CalleeBinding,
  AddPromptField,
  AddPromptContext,
  PromptProviderInfo,
  SpanKind,
  SpanMessage,
  LLMSpanDetails,
  PromptID,
  Span,
  Trace,
  TraceSummary,
  TraceWithSpans,
  TraceChangeType,
  TraceChangeEvent,
  TraceStreamEvent,
  TraceProviderInfo,
  ExecuteRequest,
  ExecuteResponse,
  ExtractedProps,
  PropValue,
  PropDefinition,
} from './shared/types.ts';
export {
  type PromptFileType,
  type ParsedFilePrompt,
  type NormalizedFilePrompt,
  type FilePromptMetadata,
} from './prompt/file/prompt-file-type.ts';
export { TSPromptFileType } from './prompt/file/ts/ts-prompt-file-type.ts';
export { type FileProvider, type FileWatchOptions, type FileWatchCallback, type GlobOptions, LocalFileProvider, MemoryFileProvider } from './file-provider.ts';
export type { SDKAdapter } from './sdk/sdk-adapter.ts';
export type {
  SetupTask,
  SetupStep,
  SetupStepBase,
  SetupCreateConfigStep,
  SetupRunCommandStep,
  SetupInstallPackageStep,
} from './shared/setup-task.ts';
export { setupStepCommand } from './shared/setup-task.ts';
export { VercelAISDK } from './sdk/vercel-ai-sdk.ts';
export { GeminiInteractionsSDK } from './sdk/gemini-interactions-sdk.ts';
export { FilePromptProvider, type FilePromptProviderOptions } from './prompt/file/file-prompt-provider.ts';
