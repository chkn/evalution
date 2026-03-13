export interface SourceSpan {
  start: number;
  end: number;
}

export interface FunctionParameter {
  name: string;
  type?: string;
  defaultValue?: any;
}

export interface PromptProperty {
  name: string;
  value: any;
  isEditable: boolean;
  hasParameterTokens: boolean;
  sourceText?: string;
  valueSpan?: SourceSpan;
  fullSpan?: SourceSpan; // full "key: value," including leading whitespace and trailing comma
  /** The prompt this property belongs to (e.g. `"prompts/greet.prompt.ts#greet"`). Used to re-parse for fresh spans. */
  promptId?: string;
}

export interface ParsedPrompt {
  id: string;
  providerId?: string;
  name: string;
  functionParameters: FunctionParameter[];
  properties: Record<string, PromptProperty>;
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
}

export interface ModelValue<Type extends string = string> {
  type: Type;
  provider?: string;
  model: string;
}

export interface ModelParameterInfo {
  name: string;
  type: string;
  defaultValue: any;
  description: string;
}

/** A pre-defined model option shown in quick-select UIs. */
export interface ModelInfo {
  /** Model ID (e.g. `'gpt-4o'`). */
  id: string;
  /** Human-readable label shown in the UI (e.g. `'GPT-4o (OpenAI)'`). */
  label: string;
}

/** Describes a single AI provider known to the SDK adapter. */
export interface ModelProviderInfo {
  /** Human-readable name (e.g. `'OpenAI'`). */
  name: string;
  /** Some of the models available for this provider. */
  models: ModelInfo[];
  /** npm package path used when auto-inserting import statements (e.g. `'@ai-sdk/openai'`). */
  importPath?: string;
}

/** Describes a model selection mode exposed by the SDK adapter (e.g. "Provider" or "Gateway"). */
export interface ModelMode<Type extends string> {
  /** The value type this mode produces (matches {@link ModelValue.type}). */
  key: Type;
  /** Label shown in the UI toggle (e.g. "Provider", "Gateway"). */
  label: string;
  /** Optional tooltip / helper text. */
  description?: string;
}

/**
 * Model catalog returned by {@link SDKAdapter.getModelCatalog}.
 * Contains the set of known providers and a curated list of models.
 */
export interface ModelCatalog<Modes extends ModelMode<string>[] = ModelMode<string>[]> {
  /** Map of provider key → provider metadata for list of known models. */
  providers: Record<string, ModelProviderInfo>;

  /**
   * Available model selection modes. When the array has more than one entry
   * the UI renders a toggle so the user can switch between them.
   */
  modes: Modes;

  /**
   * Returns the source representation of a model value.
   * If not provided, the source text will not be shown in the UI.
   */
  modelSourceText?(value: ModelValue<Modes[number]['key']>): string;
}

export interface ExecuteRequest {
  stream?: boolean;
  functionParams?: any[];
}

// ── Add Prompt flow ─────────────────────────────────────────────────────────

/** Describes a single form field rendered by the Add Prompt dialog. */
export interface AddPromptField {
  /** Key used to identify this field's value (e.g. `'name'`). */
  name: string;
  /** Human-readable label shown next to the input. */
  label: string;
  /** The kind of input control to render. */
  type: 'text' | 'select';
  /** Whether the field must be filled before submission. */
  required?: boolean;
  /** Pre-filled value. */
  defaultValue?: string;
  /** Placeholder text shown when the field is empty. */
  placeholder?: string;
  /** Available choices when `type` is `'select'`. */
  options?: { label: string; value: string }[];
}

/**
 * Returned by {@link PromptProvider.addPrompt} when additional user input is
 * needed before the prompt can be created.
 */
export interface AddPromptContext {
  /** The form fields the provider needs the user to fill in. */
  fields: AddPromptField[];
}

/** Information about a registered provider, returned by `GET /api/providers`. */
export interface PromptProviderInfo {
  id: string;
  displayName?: string;
  description?: string;
  icon?: string;
  hasAddPrompt: boolean;
}
