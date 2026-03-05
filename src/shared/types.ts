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

export interface ModelValue {
  type: 'string' | 'function';
  provider?: string;
  model: string;
  hasParameterTokens?: boolean;
}

export interface ModelParameterInfo {
  name: string;
  type: string;
  defaultValue: any;
  description: string;
}

export interface ExecuteRequest {
  stream?: boolean;
  functionParams?: any[];
}
