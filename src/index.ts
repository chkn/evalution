// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

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
export type { EvalutionConfig } from "./config.ts";
export {
  type FileProvider,
  type FileWatchCallback,
  type FileWatchOptions,
  type GlobOptions,
  LocalFileProvider,
  MemoryFileProvider,
} from "./file-provider.ts";
export {
  FilePromptProvider,
  type FilePromptProviderOptions,
} from "./prompt/file/file-prompt-provider.ts";
export type {
  FilePromptMetadata,
  NormalizedFilePrompt,
  ParsedFilePrompt,
  PromptFileType,
} from "./prompt/file/prompt-file-type.ts";
export { TSPromptFileType } from "./prompt/file/ts/ts-prompt-file-type.ts";
export type { PromptProvider } from "./prompt/prompt-provider.ts";
export { GeminiInteractionsSDK } from "./sdk/gemini-interactions-sdk.ts";
export type { SDKAdapter } from "./sdk/sdk-adapter.ts";
export { VercelAISDK } from "./sdk/vercel-ai-sdk.ts";
export type {
  SetupCreateConfigStep,
  SetupInstallPackageStep,
  SetupRunCommandStep,
  SetupStep,
  SetupStepBase,
  SetupTask,
} from "./shared/setup-task.ts";
export { setupStepCommand } from "./shared/setup-task.ts";
export type {
  AddPromptContext,
  AddPromptField,
  CalleeBinding,
  ChangeEventType,
  ExecuteRequest,
  ExecuteResponse,
  ExtractedProps,
  LLMSpanDetails,
  ModelCatalog,
  ModelGroupInfo,
  ModelInfo,
  ModelPropValue,
  ModelValueType,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPrompt,
  NormalizedPromptUpdates,
  NormalizedToolCall,
  ParsedPrompt,
  PromptChangeEvent,
  PromptID,
  PromptProviderInfo,
  PropDefinition,
  PropValue,
  SourceSpan,
  Span,
  SpanKind,
  SpanMessage,
  Trace,
  TraceChangeEvent,
  TraceChangeType,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "./shared/types.ts";
export { MemoryTraceProvider } from "./trace/memory-trace-provider.ts";
export {
  createTracerForPrompt,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
  PROMPT_PROVIDER_ID_ATTRIBUTE,
  SPAN_KIND_ATTRIBUTE,
} from "./trace/prompt-tracer.ts";
export type { TraceProvider } from "./trace/trace-provider.ts";
