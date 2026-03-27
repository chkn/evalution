import { describe, it, expect } from 'vitest';
import { defaultValueForType } from './utils';
import type { PropDefinition } from '../shared/types';

type PropType = PropDefinition['type'];

describe('defaultValueForType', () => {
  it('returns 0 for number primitives', () => {
    const type: PropType = { kind: 'primitive', syntax: 'number' };
    expect(defaultValueForType(type)).toEqual({ kind: 'primitive', value: 0 });
  });

  it('returns false for boolean primitives', () => {
    const type: PropType = { kind: 'primitive', syntax: 'boolean' };
    expect(defaultValueForType(type)).toEqual({ kind: 'primitive', value: false });
  });

  it('returns empty string for string primitives', () => {
    const type: PropType = { kind: 'primitive', syntax: 'string' };
    expect(defaultValueForType(type)).toEqual({ kind: 'primitive', value: '' });
  });

  it('returns empty array for array types', () => {
    const type: PropType = { kind: 'array', syntax: 'string[]', elementType: { kind: 'primitive', syntax: 'string' } };
    expect(defaultValueForType(type)).toEqual({ kind: 'array', elements: [] });
  });

  it('returns the first constant value from a union', () => {
    const type: PropType = {
      kind: 'union',
      syntax: '"low" | "medium" | "high"',
      types: [
        { kind: 'constant', syntax: '"low"', value: 'low' },
        { kind: 'constant', syntax: '"medium"', value: 'medium' },
      ],
    };
    expect(defaultValueForType(type)).toEqual({ kind: 'primitive', value: 'low' });
  });

  it('falls back to first type in a union with no constants', () => {
    const type: PropType = {
      kind: 'union',
      syntax: 'number | string',
      types: [
        { kind: 'primitive', syntax: 'number' },
        { kind: 'primitive', syntax: 'string' },
      ],
    };
    expect(defaultValueForType(type)).toEqual({ kind: 'primitive', value: 0 });
  });
});
