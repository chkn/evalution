// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

export {
  isVariationLoaderHookRegistered,
  registerVariationLoaderHook,
} from "./cli/variation-loader-hook.ts";
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
export {
  type CreateDatasetInput,
  DatasetNotFoundError,
  type DatasetProvider,
  DatasetValidationError,
  type ListRowsOptions,
  type NewDatasetRow,
} from "./dataset/dataset-provider.ts";
export type {
  Dataset,
  DatasetChangeEvent,
  DatasetChangeType,
  DatasetField,
  DatasetFieldShape,
  DatasetProviderInfo,
  DatasetRow,
  DatasetRowSource,
  DatasetRowsOverview,
  DatasetRowUpdate,
  DatasetSummary,
} from "./dataset/dataset-types.ts";
export { runDatasetMigrations } from "./dataset/db/migrate.ts";
export {
  LocalDirectoryDatasetProvider,
  type LocalDirectoryDatasetProviderOptions,
} from "./dataset/local-directory-dataset-provider.ts";
export {
  type TursoCreateDatasetOptions,
  TursoDatasetProvider,
} from "./dataset/turso-dataset-provider.ts";
export { runEvalMigrations } from "./eval/db/migrate.ts";
export { EvalNotFoundError, type EvalProvider } from "./eval/eval-provider.ts";
export {
  DEFAULT_EVAL_CONCURRENCY,
  EvalRunner,
  type EvalRunnerOptions,
  EvalRunRefusedError,
  type StartEvalRunOptions,
} from "./eval/eval-runner.ts";
export type {
  EvalArm,
  EvalArmSpec,
  EvalChangeEvent,
  EvalChangeType,
  EvalCheck,
  EvalCheckOutcome,
  EvalCheckResult,
  EvalCounts,
  EvalDefinition,
  EvalDefinitionPatch,
  EvalInputs,
  EvalProviderInfo,
  EvalResults,
  EvalRowResult,
  EvalRowStatus,
  EvalRun,
  EvalRunProgress,
  EvalRunStatus,
  EvalRunSummary,
  EvalSummary,
  EvalTraceRun,
  NewEvalDefinition,
  NewEvalRun,
  TraceCheckResult,
} from "./eval/eval-types.ts";
export {
  LocalEvalProvider,
  type LocalEvalProviderOptions,
  openLocalEvalProvider,
} from "./eval/local-eval-provider.ts";
export { TursoEvalProvider } from "./eval/turso-eval-provider.ts";
export type {
  FileProvider,
  FileWatchCallback,
  FileWatchOptions,
  GlobOptions,
  ImportOptions,
} from "./file-provider.ts";
export { LocalFileProvider } from "./file-provider-local.ts";
export { MemoryFileProvider } from "./file-provider-memory.ts";
export { OverlayFileProvider } from "./file-provider-overlay.ts";
export {
  collectInputSlots,
  findInputCycle,
  type InputBindings,
  type InputSignature,
  type InputSlot,
  type InputSource,
  type InstanceResolver,
  inputReferenceProblems,
  matchSourcesToSlots,
  namedBindings,
  type ResolutionContext,
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
  type Check,
  type CheckDefinition,
  type CheckOutcome,
  type CheckRun,
  check,
  isCheck,
} from "./prompt/playground/check.ts";
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
  type DeclaredInstance,
  type PlaygroundModuleError,
  type RegisteredCheck,
  type RegisteredResource,
  type RegisteredSource,
  type ResourceBinding,
  type ResourceLease,
  ResourceRegistry,
  resourceParameterNames,
} from "./prompt/playground/resource-registry.ts";
export {
  type ExecuteOptions,
  type ExecuteResult,
  type OpenOnHeadOptions,
  type PreparedCheck,
  type PromptProvider,
  type PromptRefLike,
  type PromptVariations,
  type PromptVersions,
  promptIdOf,
  type ResolvedPromptInputs,
  toPromptRef,
  type UpdatePromptResult,
  VariationConflictError,
} from "./prompt/prompt-provider.ts";
export {
  canonicalizeUpdates,
  fieldValuesOf,
  mergeUpdates,
  serializeUpdates,
} from "./prompt/variations/canonical-updates.ts";
export { runVariationMigrations } from "./prompt/variations/db/migrate.ts";
export {
  LocalVariationStore,
  openLocalVariationStore,
} from "./prompt/variations/local-variation-store.ts";
export {
  type MergeOutcome,
  mergeIntoWip,
  PROMPT_FIELD,
  rebaseUpdates,
  resolveConflicts,
} from "./prompt/variations/rebase.ts";
export { TursoVariationStore } from "./prompt/variations/turso-variation-store.ts";
export type {
  NewWip,
  StoredVariation,
  VariationContent,
  VariationStore,
  WipChanges,
} from "./prompt/variations/variation-store.ts";
export {
  GitVersioning,
  type GitVersioningOptions,
} from "./prompt/versioning/git-versioning.ts";
export type {
  HeadState,
  VersionHistoryOptions,
  VersioningAdapter,
} from "./prompt/versioning/versioning-adapter.ts";
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
export { isValidInstanceName } from "./shared/instance-names.ts";
export type {
  AddPromptContext,
  AddPromptField,
  Annotation,
  AnnotationChanges,
  AnnotationEvent,
  AnnotationEventOp,
  AnnotationKind,
  AnnotationSource,
  CalleeBinding,
  ChangeEventType,
  ChatPromptUpdates,
  CheckInfo,
  ConflictChoices,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionInput,
  ExtractedProps,
  FieldValues,
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
  PendingConflicts,
  PromptChangeEvent,
  PromptID,
  PromptInputSources,
  PromptProviderInfo,
  PromptRef,
  PromptStyle,
  PropDefinition,
  PropType,
  PropValue,
  QuestionsPromptUpdates,
  RebaseResult,
  ResourceInfo,
  ResourceInstanceInput,
  ResourceScope,
  RunResources,
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
  TraceEvalRun,
  TraceLiveEvent,
  TraceProviderInfo,
  TraceStreamEvent,
  TraceSummary,
  TraceWithSpans,
  UpdatePromptResponse,
  ValueCatalog,
  ValueCatalogGroup,
  ValueCatalogPreset,
  ValueFactory,
  VariationConflict,
  VariationId,
  VariationInfo,
  VersionId,
  VersionInfo,
} from "./shared/types.ts";
export {
  createLocalTursoClient,
  type LocalTursoClientOptions,
} from "./trace/db/local-turso-client.ts";
export { MIGRATIONS_TABLE, runMigrations } from "./trace/db/migrate.ts";
export { TRACE_QUERY_SCHEMA } from "./trace/db/query-schema.ts";
export {
  DEFAULT_MAX_QUERY_ROWS,
  DEFAULT_QUERY_TIMEOUT_MS,
  type ReadOnlyQueryRunner,
  SqlQueryError,
  type SqlQueryOptions,
  type SqlQueryResult,
} from "./trace/db/read-only-query.ts";
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
  mergePromptIdentity,
  PROMPT_ID_ATTRIBUTE,
  PROMPT_INPUTS_ATTRIBUTE,
  PROMPT_NAME_ATTRIBUTE,
  PROMPT_PROVIDER_ID_ATTRIBUTE,
  PROMPT_VARIATION_ATTRIBUTE,
  PROMPT_VERSION_ATTRIBUTE,
  type PromptSpanInfo,
  type PromptsFactory,
  type PromptsHelper,
  type PromptsHelperOptions,
  SPAN_KIND_ATTRIBUTE,
} from "./trace/prompt-tracer.ts";
export { mergeSpans } from "./trace/span-merge.ts";
export {
  BaseTraceIngestor,
  PLAYGROUND_RESOURCE,
  type TraceIngestor,
} from "./trace/trace-ingestor.ts";
export type { TraceProvider } from "./trace/trace-provider.ts";
export { BaseTraceProvider, type TraceSink } from "./trace/trace-sink.ts";
export {
  DEPLOYMENT_ENVIRONMENT_ATTRIBUTE,
  PLAYGROUND_ENVIRONMENT,
  SERVICE_NAME_ATTRIBUTE,
  spanMessages,
} from "./trace/trace-types.ts";
export { TursoTraceProvider } from "./trace/turso-trace-provider.ts";
