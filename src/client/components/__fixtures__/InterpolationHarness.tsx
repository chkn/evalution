import { useState } from 'react';
import PlaygroundEditor from '../PlaygroundEditor';
import type { NormalizedPrompt, NormalizedPromptUpdates, PropDefinition } from '../../../shared/types';

// A leaf `name` plus an object `config` with `name`/`age` children — exercises
// both top-level identifiers and nested drill-in (`config.name`).
const FUNCTION_PARAMETERS: PropDefinition[] = [
  { name: 'name', type: { kind: 'primitive', syntax: 'string' }, optional: false },
  {
    name: 'config',
    optional: false,
    type: {
      kind: 'object',
      syntax: '{ name: string; age: number }',
      properties: [
        { name: 'name', type: { kind: 'primitive', syntax: 'string' }, optional: false },
        { name: 'age', type: { kind: 'primitive', syntax: 'number' }, optional: false },
      ],
    },
  },
];

function makePrompt(functionParameters: PropDefinition[]): NormalizedPrompt {
  return {
    id: 'test',
    providerId: 'test',
    name: 'test',
    functionParameters,
    modelEditable: true,
    system: { kind: 'primitive', value: '' },
    systemEditable: true,
    messages: [{ role: 'user', content: { kind: 'primitive', value: '' } }],
    messagesEditable: true,
    modelParameters: [],
  };
}

/**
 * Renders PlaygroundEditor for exercising `${…}` tokenization and the
 * interpolatable autocomplete. Set `withParams={false}` to drive the
 * no-interpolatables behaviour.
 */
export function InterpolationHarness({ withParams = true }: { withParams?: boolean }) {
  const [prompt, setPrompt] = useState<NormalizedPrompt>(
    makePrompt(withParams ? FUNCTION_PARAMETERS : []),
  );
  const handleUpdate = (updates: NormalizedPromptUpdates) =>
    setPrompt(prev => ({ ...prev, ...updates } as NormalizedPrompt));
  return <PlaygroundEditor prompt={prompt} onUpdate={handleUpdate} modelCatalog={{ models: [] }} />;
}
