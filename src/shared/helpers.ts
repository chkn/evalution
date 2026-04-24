import type { PropValue } from 'ts-proppy';
import type { SpanKind } from './types.ts';

export function otelOperationToSpanKind(operationName: any): SpanKind {
  switch (operationName) {
    case 'chat':
    case 'response':
    case 'text_completion':
    case 'generate_content':
      return 'LLM';
    case 'execute_tool':
      return 'TOOL';
    case 'create_agent':
    case 'invoke_agent':
      return 'AGENT';
    case 'embeddings':
      return 'EMBEDDING';
    default:
      return 'DEFAULT';
  }
}

/** Whether a property value can be edited in the UI. */
export function isEditable(value: PropValue): boolean {
  return value.kind !== 'raw' && !(value.kind === 'functionCall' && !value.import);
}

export function isPropValue(a: unknown): a is PropValue {
  return !!a && typeof a === 'object' && 'kind' in a;
}

export function propValueEquals(a: unknown, b: PropValue | undefined): boolean {
  if (b === undefined) return a === undefined;
  if (!isPropValue(a)) return false;
  switch (b.kind) {
    case 'primitive':
    case 'template':
      return a.kind === b.kind && a.value === b.value;
    case 'functionCall':
      return (
        a.kind === 'functionCall' &&
        a.callee === b.callee &&
        a.args.length === b.args.length &&
        a.args.every((arg, i) => propValueEquals(arg, b.args[i]))
      );
    case 'lambda':
      return a.kind === 'lambda' && a.parameters.join(',') === b.parameters.join(',') && a.body === b.body;
    case 'object': {
      if (a.kind !== 'object') return false;
      const aKeys = Object.keys(a.properties);
      const bKeys = Object.keys(b.properties);
      return (
        aKeys.length === bKeys.length &&
        aKeys.every(k => k in b.properties && propValueEquals(a.properties[k], b.properties[k]))
      );
    }
    case 'array':
    case 'tuple':
      return (
        a.kind === b.kind &&
        a.elements.length === b.elements.length &&
        a.elements.every((el, i) => propValueEquals(el, b.elements[i]))
      );
    case 'raw':
      return a.kind === 'raw' && a.sourceText === b.sourceText;
    default:
      return false;
  }
}