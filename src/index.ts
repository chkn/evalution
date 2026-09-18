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
  canonicalArgumentKey,
  collectInputSlots,
  type InputSlot,
  type InputSource,
  matchSourcesToSlots,
  type ResourceResolver,
  resolveExecutionInput,
  resolveExecutionInputs,
  stampReceipts,
} from "./prompt/execution-inputs.ts";
export {
  FilePromptProvider,
  type FilePromptProviderOptions,
} from "./prompt/file/file-prompt-provider.ts";
export type {
  FactoriesProbe,
  FilePromptMetadata,
  NormalizedFilePrompt,
  ParsedFilePrompt,
  ParsePromptsOptions,
  ProbeResult,
  ProbeResults,
  ProjectProbeRequest,
  PromptFileType,
  SlotMatchRequest,
  SlotMatchSource,
  TypeExpressionProbe,
  TypeProbe,
  TypeProbeRequest,
  TypeResolutionRequest,
  TypeResolutionResult,
} from "./prompt/file/prompt-file-type.ts";
export { TSPromptFileType } from "./prompt/file/ts/ts-prompt-file-type.ts";
export {
  type DynamicResourceDefinition,
  isResource,
  isStandardSchema,
  type ResolvedResourceInputs,
  type Resource,
  type ResourceDefinition,
  type ResourceInput,
  type ResourceInputs,
  type ResourceInstance,
  type ResourceOutputDefinition,
  resource,
  type StaticResourceDefinition,
} from "./prompt/playground/resource.ts";
export {
  DEFAULT_PLAYGROUND_INCLUDE_PATTERNS,
  type PlaygroundModuleError,
  type RegisteredResource,
  type RegisteredSource,
  type ResourceBinding,
  type ResourceLease,
  ResourceRegistry,
  resourceParameterNames,
} from "./prompt/playground/resource-registry.ts";
export type {
  ExecuteOptions,
  PromptProvider,
  ResolvedPromptInputs,
} from "./prompt/prompt-provider.ts";
export { GeminiInteractionsSDK } from "./sdk/gemini-interactions-sdk.ts";
export {
  assertUpdateStyle,
  type ExecuteConfigOptions,
  type ExecutionHandle,
  type SDKAdapter,
} from "./sdk/sdk-adapter.ts";
export {
  TypeSafeSDK,
  type TypeSafeSDKOptions,
} from "./sdk/typesafe-sdk/index.ts";
export {
  PROMPT_IDENTITY,
  type SystemOneCallOptions,
  type SystemOneCallRecord,
  TypeSafeTelemetry,
} from "./sdk/typesafe-sdk/telemetry.ts";
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
  Annotation,
  AnnotationEvent,
  AnnotationEventOp,
  AnnotationKind,
  AnnotationSource,
  CalleeBinding,
  ChangeEventType,
  ChatPromptUpdates,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  ExtractedProps,
  InputLayout,
  LLMSpanDetails,
  NormalizedChatPrompt,
  NormalizedMessage,
  NormalizedParameter,
  NormalizedPrompt,
  NormalizedPromptBase,
  NormalizedPromptUpdates,
  NormalizedQuestionsPrompt,
  NormalizedToolCall,
  ParsedPrompt,
  PromptChangeEvent,
  PromptID,
  PromptInputSources,
  PromptProviderInfo,
  PromptStyle,
  PropDefinition,
  PropType,
  PropValue,
  QuestionsPromptUpdates,
  ResourceInfo,
  ResourceScope,
  SourceSpan,
  Span,
  SpanContentPart,
  SpanImagePart,
  SpanKind,
  SpanMessage,
  SpanMessageRole,
  SpanTextPart,
  ToolSpanDetails,
  Trace,
  TraceChangeEvent,
  TraceChangeType,
  TraceLiveEvent,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
  ValueCatalog,
  ValueCatalogGroup,
  ValueCatalogPreset,
  ValueFactory,
} from "./shared/types.ts";
export {
  createLocalTursoClient,
  type LocalTursoClientOptions,
} from "./trace/db/local-turso-client.ts";
export { MIGRATIONS_TABLE, runMigrations } from "./trace/db/migrate.ts";
export {
  LocalDatabaseTraceProvider,
  type LocalDatabaseTraceProviderOptions,
} from "./trace/local-database-trace-provider.ts";
export { MemoryTraceProvider } from "./trace/memory-trace-provider.ts";
export { setupGlobalOTelPipeline } from "./trace/otel-global-pipeline.ts";
export { OTelTraceIngestor } from "./trace/otel-trace-ingestor.ts";
export {
  type NormalizedOtlpEvent,
  type NormalizedOtlpSpan,
  normalizeOtlpRequest,
} from "./trace/otlp/normalize.ts";
export { decodeOtlpProtobuf } from "./trace/otlp/otlp-protobuf.ts";
export { OtlpTraceIngestor } from "./trace/otlp-trace-ingestor.ts";
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
export { spanMessages } from "./trace/trace-types.ts";
export { TursoTraceProvider } from "./trace/turso-trace-provider.ts";
