// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
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
 * @module evalution
 */
export type { EvalutionConfig } from "./config.ts";
export type {
  FileProvider,
  FileWatchCallback,
  FileWatchOptions,
  GlobOptions,
  ImportOptions,
} from "./file-provider.ts";
export { LocalFileProvider } from "./file-provider-local.ts";
export { MemoryFileProvider } from "./file-provider-memory.ts";
export {
  collectInputSlots,
  type InputSlot,
  type InputSource,
  matchSourcesToSlots,
  type ResourceResolver,
  resolveExecutionInput,
  resolveExecutionInputs,
} from "./prompt/execution-inputs.ts";
export {
  FilePromptProvider,
  type FilePromptProviderOptions,
} from "./prompt/file/file-prompt-provider.ts";
export type {
  FilePromptMetadata,
  NormalizedFilePrompt,
  ParsedFilePrompt,
  ParsePromptsOptions,
  PromptFileType,
  SlotMatchRequest,
  SlotMatchSource,
  TypeProbe,
  TypeProbeRequest,
} from "./prompt/file/prompt-file-type.ts";
export { TSPromptFileType } from "./prompt/file/ts/ts-prompt-file-type.ts";
export {
  type DynamicResourceDefinition,
  isResource,
  type ResolvedNeeds,
  type Resource,
  type ResourceDefinition,
  type ResourceInstance,
  type ResourceNeeds,
  resource,
  type StaticResourceDefinition,
} from "./prompt/playground/resource.ts";
export {
  DEFAULT_PLAYGROUND_INCLUDE_PATTERNS,
  type PlaygroundModuleError,
  type RegisteredResource,
  type ResourceLease,
  ResourceRegistry,
} from "./prompt/playground/resource-registry.ts";
export type {
  ExecuteOptions,
  PromptProvider,
  ResolvedInputs,
} from "./prompt/prompt-provider.ts";
export { GeminiInteractionsSDK } from "./sdk/gemini-interactions-sdk.ts";
export type {
  ExecuteConfigOptions,
  ExecutionHandle,
  SDKAdapter,
} from "./sdk/sdk-adapter.ts";
export { VercelAISDK } from "./sdk/vercel-ai-sdk/index.ts";
export {
  type PerPromptTelemetry,
  type PerTraceTelemetry,
  VercelAISDKTelemetry,
  type VercelAISDKTelemetryOptions,
} from "./sdk/vercel-ai-sdk/telemetry.ts";
export type {
  AddPromptContext,
  AddPromptField,
  CalleeBinding,
  ChangeEventType,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  ExtractedProps,
  InputLayout,
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
  PromptInputSources,
  PromptProviderInfo,
  PropDefinition,
  PropType,
  PropValue,
  ResourceInfo,
  ResourceScope,
  SourceSpan,
  Span,
  SpanKind,
  SpanMessage,
  ToolSpanDetails,
  Trace,
  TraceChangeEvent,
  TraceChangeType,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
} from "./shared/types.ts";
export { MemoryTraceProvider } from "./trace/memory-trace-provider.ts";
export { setupGlobalOTelPipeline } from "./trace/otel-global-pipeline.ts";
export { OTelTraceIngestor } from "./trace/otel-trace-ingestor.ts";
export {
  createTracerForPrompt,
  getPromptSpanAttributes,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_INPUTS_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
  PROMPT_PROVIDER_ID_ATTRIBUTE,
  type PromptSpanInfo,
  type PromptsFactory,
  type PromptsHelper,
  type PromptsHelperOptions,
  SPAN_KIND_ATTRIBUTE,
} from "./trace/prompt-tracer.ts";
export { mergeSpans } from "./trace/span-merge.ts";
export {
  BaseTraceIngestor,
  type TraceIngestor,
} from "./trace/trace-ingestor.ts";
export type { TraceProvider } from "./trace/trace-provider.ts";
export { BaseTraceProvider, type TraceSink } from "./trace/trace-sink.ts";
