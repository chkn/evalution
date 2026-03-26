import type { PropValue } from 'ts-proppy';

/** Whether a property value can be edited in the UI. */
export function isEditable(value: PropValue): boolean {
  return value.kind !== 'raw' && !(value.kind === 'functionCall' && !value.import);
}
