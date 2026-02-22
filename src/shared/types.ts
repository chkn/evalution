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
  name: string;
  functionParameters: FunctionParameter[];
  properties: Record<string, PromptProperty>;
  metadata?: Record<string, any>;
}

export interface ModelValue {
  type: 'string' | 'function';
  provider?: string;
  model: string;
  hasParameterTokens?: boolean;
}

export interface ExecuteRequest {
  stream?: boolean;
  functionParams?: Record<string, any>;
}
