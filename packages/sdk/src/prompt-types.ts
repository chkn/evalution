// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import type {
  ExtractedProps,
  PropDefinition,
  PropValue,
  ValueFactory,
} from "ts-proppy";

/**
 * Low-level prompt representation produced by a
 * `PromptFileType`. It exposes the raw `extractedProps` from the parser
 * and uses SDK-specific property names (e.g. `model`, `system`, `messages`).
 *
 * Not intended for public consumption — `PromptProvider` implementations
 * convert this into a {@link NormalizedPrompt} via an {@link SDKAdapter} before
 * returning it to callers.
 */
export interface ParsedPrompt {
  id: string;
  providerId?: string;
  /**
   * Author-supplied stable alias for this prompt, globally unique across
   * providers. Survives file moves/renames and is registered in the prompt
   * registry so runtime traces can resolve back to this prompt.
   */
  globalId?: string;
  name: string;
  functionParameters: PropDefinition[];
  extractedProps: ExtractedProps;
  metadata?: unknown;
  treePath?: string[];
}

/**
 * A single message in a conversation, in a form that is independent of any
 * particular SDK's message shape.
 */
export interface NormalizedMessage {
  /** Role identifier (`'system'`, `'user'`, `'assistant'`, `'tool'`, …). */
  role: string;
  /** Message content. Typically a primitive or template string, but any
   * {@link PropValue} is allowed so non-string content (e.g. structured
   * content arrays) can round-trip through the editor. */
  content: PropValue;
  /** Optional tool calls attached to an assistant message. */
  toolCalls?: NormalizedToolCall[];
}

/** A tool invocation emitted by an assistant message. */
export interface NormalizedToolCall {
  /** The name of the tool / function to invoke. */
  toolName: string;
  /** Arguments to the tool, as a JSON string. */
  args: string;
}

/**
 * A model parameter (`temperature`, `maxTokens`, …) attached to a prompt.
 * Mirrors the `PropDefinition` + current value pair that the playground UI
 * needs for rendering a parameter editor.
 */
export interface NormalizedParameter {
  /** Describes the parameter's name, type, and documentation. */
  def: PropDefinition;
  /** The parameter's current value, or `undefined` if not set on the prompt. */
  value?: PropValue;
}

/**
 * What every {@link NormalizedPrompt} has, whatever its {@link PromptStyle}.
 */
export interface NormalizedPromptBase {
  id: string;
  providerId?: string;
  /**
   * Author-supplied stable alias for this prompt, globally unique across
   * providers. Survives file moves/renames and is registered in the prompt
   * registry so runtime traces can resolve back to this prompt.
   */
  globalId?: string;
  name: string;
  functionParameters: PropDefinition[];
  metadata?: unknown;

  /**
   * Controls where this prompt appears in the sidebar tree.
   *
   * Each element is a path segment. The last segment is treated as the leaf
   * group label (analogous to a file name) and all preceding segments are
   * rendered as collapsible directory nodes.
   *
   * Prompts that share the same `treePath` are grouped under the same leaf
   * node. When omitted, the prompt is placed at the root level.
   *
   * @example ['src', 'prompts', 'greeting.prompt.ts']
   */
  treePath?: string[];

  /** The model reference (e.g. a provider call or gateway string). */
  model?: PropValue;
  /**
   * Whether this SDK lets the model be chosen from the playground.
   *
   * A capability of the SDK, not a verdict on the current value: an editor
   * also checks that the value itself has an editable shape (see
   * `isEditable`), and renders read-only when either answer is no.
   */
  modelEditable: boolean;

  /**
   * Model parameters currently set on the prompt (everything that isn't
   * part of the style's own authored content).
   */
  modelParameters: NormalizedParameter[];
  /**
   * False when the model parameters can't be changed here — a saved
   * variation shown read-only, say. Absent means they can.
   */
  modelParametersEditable?: boolean;

  /**
   * Named values the SDK needs to **execute** the config this prompt renders,
   * supplied at run time rather than authored in the file.
   *
   * Distinct from {@link functionParameters}, which answers *what does this
   * prompt take?* — this answers *what does running it require?*, which the
   * function signature cannot express. The Vercel AI SDK's `toolsContext` is
   * the motivating case: tools that declare a `contextSchema` need a context
   * object the prompt function never sees.
   *
   * Absent when the prompt needs nothing beyond its arguments. Present with an
   * unresolved type when the requirement is known but its shape is not — a
   * usable state, and better than the silent failure at the first tool call
   * that omitting it would produce.
   */
  executeParameters?: PropDefinition[];

  /**
   * Non-authored sources that can fill this prompt's input slots — currently
   * code-defined resources. Absent when the provider offers none.
   */
  inputSources?: PromptInputSources;

  /**
   * Slot path → how to lay out a fan-out slot's fields in the execute panel.
   * Any path not named here uses `"expanded"`.
   *
   * Set by an {@link SDKAdapter} whose own API shape is the reason a slot
   * fans out — e.g. the Vercel AI SDK's `toolsContext`, which is keyed per
   * tool because tools are resolved individually, not because prompt authors
   * think in terms of separate contexts. Mirrors the `functionSlots` /
   * `executeSlots` split on {@link PromptInputSources}, which exists for the
   * same reason: a function parameter and an execute parameter may share a
   * name.
   */
  inputLayout?: {
    functionSlots?: Record<string, InputLayout>;
    executeSlots?: Record<string, InputLayout>;
  };

  /**
   * Where this prompt was read from. Absent when the provider has no notion
   * of versions, in which case the prompt is always head.
   */
  ref?: PromptRef;
  /** The base version, when {@link ref} is a version or a variation. */
  version?: VersionInfo;
  /** The variation, when {@link ref} names one. */
  variation?: VariationInfo;
  /**
   * True when a WIP variation exists for this prompt at head — the dirty
   * indicator. Reported on the head prompt, whatever ref is open.
   */
  dirty?: boolean;
  /** The id of the head WIP variation, when {@link dirty}. */
  wipId?: VariationId;
  /**
   * True when this prompt's base is the working tree, so it can run. False
   * for an old version, or a variation made against one.
   */
  atHead?: boolean;
}

/**
 * An opaque, immutable name for a state of the world — for a git project, a
 * commit.
 */
export type VersionId = string;

/** An opaque id for a {@link VariationInfo | variation}. */
export type VariationId = string;

/**
 * Which prompt, in which state.
 *
 * A variation already knows its base, so `{ variation }` is complete. There is
 * deliberately no `{ version, variation }` pair: that is a rebase, which
 * produces a new variation with its own id.
 */
export type PromptRef =
  /** Head: the prompt as it is on disk now. */
  | { promptId: string; version?: undefined; variation?: undefined }
  /** The prompt as it was at a saved version. */
  | { promptId: string; version: VersionId; variation?: undefined }
  /** A variation, applied to its base commit (or the working tree, without one). */
  | { promptId: string; variation: VariationId; version?: undefined };

/** A saved state of the world: a commit. See {@link VersionId}. */
export interface VersionInfo {
  id: VersionId;
  /** Commit subject. */
  message?: string;
  author?: string;
  /** When the version was made (ms). */
  time: number;
}

/**
 * A prompt's field values, keyed like a variation's fields (`system`,
 * `modelParameters.temperature`, …) — `null` for a field the prompt doesn't
 * have.
 */
export type FieldValues = Record<string, unknown>;

/**
 * One field that could not be merged: both sides changed it, differently.
 * `field` is `"system"`, `"modelParameters.temperature"`, or the pseudo-field
 * `"prompt"` when the prompt itself no longer exists at the target.
 */
export interface VariationConflict {
  field: string;
  /** The value both sides started from. */
  base: unknown;
  /** The value on the side being merged into (head, or the unsaved edits). */
  target: unknown;
  /** The value the variation wants. */
  variation: unknown;
}

/**
 * Conflicts a WIP variation is waiting on the user to resolve. While present,
 * the WIP can neither run nor be saved.
 */
export interface PendingConflicts {
  /**
   * The working tree's values for every field involved, as they were when
   * the conflict arose: what the resolved WIP is based on.
   */
  targetValues: FieldValues;
  /** Every field that did merge, already applied. */
  updates: NormalizedPromptUpdates;
  conflicts: VariationConflict[];
  /** How to label each side in the UI. */
  labels: { target: string; variation: string };
}

/**
 * An immutable set of {@link NormalizedPromptUpdates} for one prompt — or,
 * when {@link wip}, the one mutable set of unsaved edits per (prompt, base).
 * It applies to the working tree; its {@link base} commit, when it has one,
 * is where it can also be shown (and one day run) as it was made.
 */
export interface VariationInfo {
  id: VariationId;
  promptId: string;
  /**
   * The commit whose copy of the prompt's file the variation was made
   * against. Absent when that file had uncommitted changes (or there's no
   * git), and for a WIP of unsaved edits to the working tree.
   */
  base?: VersionId;
  updates: NormalizedPromptUpdates;
  /** Whether this is a work-in-progress (unsaved, mutable) variation. */
  wip: boolean;
  /** For a WIP: whether it holds the unsaved edits to head. */
  onHead?: boolean;
  /** Names pointing at this variation. */
  names: string[];
  /** For a WIP opened from a named variation: that name. */
  originName?: string;
  /** For a WIP: conflicts awaiting resolution. */
  pending?: PendingConflicts;
  createdAt: number;
  updatedAt: number;
}

/**
 * Which kind of editor a prompt is authored in. Chosen by the
 * {@link SDKAdapter}, since it is the SDK's request shape that decides it.
 *
 * A closed set: the client is a prebuilt bundle, so an adapter picks among
 * the editors it has rather than shipping its own.
 */
export type PromptStyle = NormalizedPrompt["style"];

/** A model driven by a system message and a conversation. */
export interface NormalizedChatPrompt extends NormalizedPromptBase {
  style: "chat";

  /** Top-level system prompt, if the SDK supports one. */
  system?: PropValue;
  /** Whether this SDK supports an arbitrary system message. */
  systemEditable: boolean;

  /** Conversation messages. */
  messages: NormalizedMessage[];
  /** Whether this SDK supports an arbitrary message list. */
  messagesEditable: boolean;
}

/** A model that answers a set of named questions about a state. */
export interface NormalizedQuestionsPrompt extends NormalizedPromptBase {
  style: "questions";

  /** What the questions are asked about. `def` is the SDK's state type. */
  state: NormalizedParameter;
  /** Whether this SDK supports an arbitrary state. */
  stateEditable: boolean;

  /**
   * The questions, as one value: an object whose property names are question
   * ids. `def` is the SDK's type for the whole collection — a `record` whose
   * value definition carries a catalog of question factories.
   */
  questions: NormalizedParameter;
  /** Whether this SDK supports adding, removing and editing questions. */
  questionsEditable: boolean;
}

/**
 * Prompt representation used by `PromptProvider` public methods and by
 * the playground UI. It hides SDK-specific property names behind a stable
 * shape, discriminated by {@link PromptStyle}.
 *
 * {@link SDKAdapter.normalizePrompt} converts a {@link ParsedPrompt} produced
 * by a `PromptFileType` into this form.
 */
export type NormalizedPrompt = NormalizedChatPrompt | NormalizedQuestionsPrompt;

/** How a fan-out slot's fields are laid out in the execute panel. */
export type InputLayout = "combined" | "expanded";

/** How long a resource's value lives, and how often `create()` runs. */
export type ResourceScope = "run" | "server";

/**
 * A code-defined resource offered as an input source, as the UI sees it.
 *
 * The resource's *value* never crosses the wire — the whole point is that only
 * running code can produce it — so this is just enough to render a chip and
 * send the choice back as an `ExecutionInput`.
 */
export interface ResourceInfo {
  /**
   * Provider-interpreted reference to this resource, relative to the
   * provider's root so it stays valid on another machine (e.g.
   * `.evalution/playground/db.ts#db`).
   */
  uri: string;
  /** Human-readable label shown on the chip. */
  label: string;
  /** How long the created value lives. See {@link ResourceScope}. */
  scope: ResourceScope;
  /**
   * Why this resource is unavailable, if it is — typically its module threw
   * at import time. Surfaced in the panel rather than hidden, so a broken
   * playground module is visible instead of silently absent.
   */
  error?: string;
  /**
   * A snapshot of the resource's current value, so the panel can preview it
   * instead of just naming it. Present only when the server already has an
   * instance to peek at — a static `value` resource, or a `scope: 'server'`
   * one it has already created — and that instance's value is plain JSON
   * data. A run-scoped resource, or one whose value isn't plain data (a live
   * handle), has nothing here; the chip is all there is to show.
   */
  value?: unknown;
  /**
   * Group path this source is displayed under, outermost first. Absent means
   * top level. Purely display metadata — never part of {@link uri} — so
   * renaming a group invalidates no saved selection. See
   * `specs/resource-hierarchy.md` §B.
   */
  group?: string[];
  /**
   * For a value source (one read off another resource): the `uri` of the
   * resource it is read from. Absent for the resource itself.
   */
  parent?: string;
  /**
   * For a value source: how many values that resource exposes in total,
   * before slot matching narrows them down for a particular slot. Only the
   * provider can supply this — after filtering, the panel cannot tell "this
   * resource exposes one value" from "it exposes five and four don't fit
   * here", and those read differently once a submenu collapses to its one
   * remaining entry.
   */
  siblings?: number;
  /**
   * The resource's declared arguments, as slots for the panel to render —
   * one per schema-valued entry of its `inputs`, in declaration order.
   * Absent when the resource takes none. Present with an unresolved (generic
   * string) editor when the requirement is known but its shape is not —
   * the checker-less degradation, same idiom as
   * {@link NormalizedPrompt.executeParameters}.
   *
   * Only the resource itself carries this — a value source (`parent` set)
   * shares its root resource's arguments rather than repeating them. See
   * `specs/resource-arguments.md` §G.
   */
  parameters?: PropDefinition[];
  /**
   * The resource's code-wired dependencies — its resource-valued `inputs`
   * entries — as input name → the dependency's {@link uri}. Only the
   * resource itself carries this, and only for dependencies discovery
   * registered. The panel lists them in its Resources section. See
   * `specs/resource-instances.md` §D.
   */
  dependencies?: Record<string, string>;
}

/**
 * Which non-authored sources can fill which of a prompt's input slots.
 *
 * Matching runs provider-side, where the checker lives (see
 * `matchResourcesToSlots`), and ships as slot paths so the panel can offer a
 * source without re-deriving the rules.
 */
export interface PromptInputSources {
  /** Every resource in scope for this prompt, identified by `uri`. */
  resources: ResourceInfo[];
  /**
   * Dotted slot path within {@link NormalizedPrompt.functionParameters}
   * (`taskId`, `ctx.db`) → URIs of the resources that can fill it.
   */
  functionSlots: Record<string, string[]>;
  /**
   * Dotted slot path within {@link NormalizedPrompt.executeParameters}
   * (`toolsContext.list_tasks.db`) → URIs of the resources that can fill it.
   */
  executeSlots: Record<string, string[]>;
  /**
   * Resource URI → (argument slot path → URIs of sources that can fill it).
   *
   * Separate from {@link functionSlots} / {@link executeSlots} and keyed by
   * URI rather than folded into the slot path, because an argument slot is a
   * property of the *resource*, not of the prompt: the same resource offers
   * the same arguments in every prompt that can see it. Absent when no
   * resource in scope declares arguments. See
   * `specs/resource-arguments.md` §G.
   */
  resourceSlots?: Record<string, Record<string, string[]>>;
}

/** Updates to a {@link NormalizedChatPrompt}. `null` removes a field. */
export interface ChatPromptUpdates {
  style: "chat";
  model?: PropValue | null;
  system?: PropValue | null;
  messages?: NormalizedMessage[] | null;
  /** Per-parameter updates, keyed by parameter name. `null` removes. */
  modelParameters?: Record<string, PropValue | null>;
}

/** Updates to a {@link NormalizedQuestionsPrompt}. `null` removes a field. */
export interface QuestionsPromptUpdates {
  style: "questions";
  model?: PropValue | null;
  state?: PropValue | null;
  questions?: PropValue | null;
  /** Per-parameter updates, keyed by parameter name. `null` removes. */
  modelParameters?: Record<string, PropValue | null>;
}

/**
 * Updates that can be applied to a {@link NormalizedPrompt} via
 * `PromptProvider.updatePromptProperties`, in the vocabulary of the
 * prompt's {@link PromptStyle}. A value of `null` removes that field from the
 * underlying source.
 */
export type NormalizedPromptUpdates =
  | ChatPromptUpdates
  | QuestionsPromptUpdates;

/**
 * A type question for a `PromptFileType` to answer on an
 * {@link SDKAdapter}'s behalf.
 *
 * Neither side can answer alone. Knowing that a Vercel AI SDK config's tools
 * imply a `toolsContext` is SDK semantics; *evaluating* that mapping is a
 * TypeScript capability. So the adapter says what to look for and the file
 * type contributes the checker.
 */
export type TypeProbe = TypeExpressionProbe | FactoriesProbe;

/** A probe that resolves a type expression to a {@link PropDefinition}. */
export interface TypeExpressionProbe {
  kind: "type";
  /**
   * The name the result is reported under — for an execute parameter, its
   * name, and the name of the resolved {@link PropDefinition}.
   */
  name: string;
  /**
   * Source text of a type expression, in the file type's
   * `PromptFileType.language`, that resolves to the type.
   *
   * In a prompt probe, the token `$config` stands for the type of whatever the
   * prompt returns, and the file type substitutes a way to name it — which
   * shape a prompt file uses is the file type's knowledge, not the adapter's.
   * A project probe has no prompt, so `$config` resolves to `never` there.
   *
   * Write it defensively: a probe that cannot find what it is looking for
   * should resolve to `never` (which means "there is no such thing"), never
   * fail to compile. That is what lets an adapter emit a probe without first
   * inspecting the parse result.
   *
   * For instance, the Vercel AI SDK derives its `toolsContext` from whichever
   * of a config's tools declare a `contextSchema`, with the `never` branch
   * covering a config that has no tools at all:
   *
   * ```ts
   * "$config extends { tools: infer T extends ToolSet } ? InferToolSetContext<T> : never"
   * ```
   */
  expression: string;
  /**
   * How to label the resolved type in the UI, when the checker's own spelling
   * would be unreadable — a deeply-instantiated mapped type is accurate and
   * useless as a label. The resolved *shape* is unaffected.
   */
  syntax?: string;
  /** Documentation shown beside the resolved definition in the UI. */
  description?: string;
}

/**
 * A probe that resolves to the {@link ValueFactory}s among some modules'
 * exports: every export that can be called to produce a value assignable to
 * {@link produces}.
 *
 * The adapter says *what* to look for; the file type knows *how* to ask in its
 * language. A module that isn't installed contributes nothing rather than
 * failing the probe.
 */
export interface FactoriesProbe {
  kind: "factories";
  /** The name the result is reported under. */
  name: string;
  /** Module specifiers whose exports to consider, e.g. `"@ai-sdk/openai"`. */
  modules: string[];
  /**
   * A type expression, in the file type's language, naming what a factory's
   * call must produce, e.g. `import("ai").LanguageModel`.
   */
  produces: string;
  /**
   * Consider a method of each export rather than the export itself: with
   * `"evaluationModel"`, an exported provider object `typeSafeAi` whose
   * `evaluationModel(…)` produces the type is found as the factory
   * `typeSafeAi.evaluationModel`, still bound to the import of `typeSafeAi`.
   */
  member?: string;
}

/**
 * What one probe resolved to: a {@link PropDefinition} for a `type` probe or
 * the {@link ValueFactory}s found by a `factories` probe; `null` for a definite
 * "no such thing" (the expression evaluated to `never`); or `undefined` for
 * "could not be evaluated".
 */
export type ProbeResult = PropDefinition | ValueFactory[] | null | undefined;

/**
 * Project probe results, keyed by probe name. See
 * {@link SDKAdapter.getProjectProbes}.
 */
export type ProbeResults = Record<string, ProbeResult>;
