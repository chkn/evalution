// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, it, expect } from 'vitest';
import { PromptRegistry } from './prompt-registry.ts';
import type { PromptProvider } from './prompt-provider.ts';
import type { NormalizedPrompt } from '../shared/types.ts';

/** A stub provider that just returns the given prompts from `getAllPrompts`. */
function stubProvider(id: string, prompts: Partial<NormalizedPrompt>[]): PromptProvider {
  return {
    id,
    async getAllPrompts() {
      return prompts.map(p => ({
        functionParameters: [],
        modelEditable: true,
        systemEditable: true,
        messages: [],
        messagesEditable: true,
        modelParameters: [],
        name: p.id!,
        ...p,
      })) as NormalizedPrompt[];
    },
    async getPrompt() {
      return null;
    },
    async execute() {
      return undefined;
    },
  };
}

function registryWith(providers: PromptProvider[]): Promise<PromptRegistry> {
  const registry = new PromptRegistry();
  return registry.rebuild(new Map(providers.map(p => [p.id, p]))).then(() => registry);
}

describe('PromptRegistry', () => {
  it('resolves a provider-scoped id registered automatically', async () => {
    const registry = await registryWith([
      stubProvider('fs', [{ id: 'a.prompt.ts#foo' }]),
    ]);

    expect(registry.resolve('a.prompt.ts#foo')).toEqual({
      providerId: 'fs',
      promptId: 'a.prompt.ts#foo',
    });
  });

  it('resolves an author global id to the scoped prompt', async () => {
    const registry = await registryWith([
      stubProvider('fs', [{ id: 'a.prompt.ts#foo', globalId: 'mod#foo' }]),
    ]);

    expect(registry.resolve('mod#foo')).toEqual({
      providerId: 'fs',
      promptId: 'a.prompt.ts#foo',
    });
  });

  it('nulls out an ambiguous id shared by two providers', async () => {
    const registry = await registryWith([
      stubProvider('fs1', [{ id: 'shared.prompt.ts#foo' }]),
      stubProvider('fs2', [{ id: 'shared.prompt.ts#foo' }]),
    ]);

    // Ambiguous ⇒ not resolvable globally.
    expect(registry.resolve('shared.prompt.ts#foo')).toBeUndefined();
  });

  it('returns undefined for an unknown global id', async () => {
    const registry = await registryWith([stubProvider('fs', [{ id: 'a.prompt.ts#foo' }])]);

    expect(registry.resolve('nope#missing')).toBeUndefined();
  });

  it('falls back to the passed provider id only when the map has nothing', async () => {
    const registry = await registryWith([]);

    // Map miss + provider id ⇒ trust the id as already scoped.
    expect(registry.resolve('a.prompt.ts#foo', 'fs')).toEqual({
      providerId: 'fs',
      promptId: 'a.prompt.ts#foo',
    });
    // Map miss + no provider id ⇒ unresolvable.
    expect(registry.resolve('a.prompt.ts#foo')).toBeUndefined();
  });

  it('prefers the map over the passed provider id for a global id', async () => {
    const registry = await registryWith([
      stubProvider('fs', [{ id: 'a.prompt.ts#foo', globalId: 'mod#foo' }]),
    ]);

    // Even with a provider id given, the global id is translated via the map to
    // the real scoped prompt id (a provider can't open a global id directly).
    expect(registry.resolve('mod#foo', 'fs')).toEqual({
      providerId: 'fs',
      promptId: 'a.prompt.ts#foo',
    });
  });

  it('reflects the latest prompts after a rebuild', async () => {
    const registry = new PromptRegistry();
    const provider = stubProvider('fs', [{ id: 'a.prompt.ts#foo', globalId: 'mod#foo' }]);
    await registry.rebuild(new Map([['fs', provider]]));
    expect(registry.resolve('mod#foo')?.promptId).toBe('a.prompt.ts#foo');

    // Prompt moved to a new file; rebuild against the updated provider.
    const moved = stubProvider('fs', [{ id: 'b.prompt.ts#foo', globalId: 'mod#foo' }]);
    await registry.rebuild(new Map([['fs', moved]]));
    expect(registry.resolve('mod#foo')?.promptId).toBe('b.prompt.ts#foo');
  });
});
