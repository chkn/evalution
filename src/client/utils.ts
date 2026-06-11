// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition, PropValue } from '../shared/types';

export function encodePromptId(id: string): string {
  return btoa(id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Returns a prompt's provider ID, which the server always populates. Logs a
 * warning and falls back to `''` if it's somehow missing, so the failure is
 * visible rather than silent (an empty provider ID won't match any prompt).
 */
export function requireProviderId(providerId: string | undefined, context: string): string {
  if (!providerId) {
    console.warn(`[evalution] Missing providerId for ${context}; prompt linking may not work.`);
    return '';
  }
  return providerId;
}

/**
 * Returns a sensible initial {@link PropValue} for a parameter type when no
 * explicit `defaultValue` is available (e.g. parameters extracted from SDK
 * type declarations that carry only type information).
 */
export function defaultValueForType(type: PropDefinition['type']): PropValue {
  if (type.kind === 'primitive') {
    if (type.syntax === 'number') return { kind: 'primitive', value: 0 };
    if (type.syntax === 'boolean') return { kind: 'primitive', value: false };
    return { kind: 'primitive', value: '' };
  }
  if (type.kind === 'array') return { kind: 'array', elements: [] };
  if (type.kind === 'union') {
    const constant = type.types.find(t => t.kind === 'constant');
    if (constant && constant.kind === 'constant') return { kind: 'primitive', value: constant.value };
    if (type.types.length > 0) return defaultValueForType(type.types[0]);
  }
  return { kind: 'primitive', value: undefined };
}
