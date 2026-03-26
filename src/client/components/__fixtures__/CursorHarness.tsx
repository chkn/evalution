import { useState } from 'react';
import PlaygroundEditor from '../PlaygroundEditor';
import type { ParsedPrompt } from '../../../shared/types';

export function makePrompt(content: string): ParsedPrompt {
  return {
    id: 'test',
    providerId: 'test',
    name: 'test',
    functionParameters: [],
    extractedProps: {
      definitions: [
        { name: 'messages', type: { kind: 'array', syntax: 'any[]', elementType: { kind: 'primitive', syntax: 'any' } }, optional: false },
      ],
      values: {
        messages: {
          kind: 'array',
          elements: [
            { kind: 'object', properties: { role: { kind: 'primitive', value: 'user' }, content: { kind: 'primitive', value: content } } },
          ],
        },
      },
    },
  };
}

/**
 * Wraps PlaygroundEditor to simulate external prompt updates (e.g. SSE-triggered
 * refetch after a save). Clicking the `[data-testid="reload"]` button replaces
 * the prompt with a fresh object built from `reloadContent`.
 */
export function CursorHarness({ initialContent = '', reloadContent }: {
  initialContent?: string;
  reloadContent?: string;
}) {
  const [prompt, setPrompt] = useState<ParsedPrompt>(makePrompt(initialContent));

  return (
    <div>
      <PlaygroundEditor prompt={prompt} onUpdate={setPrompt} onDirtyChange={() => {}} />
      {reloadContent !== undefined && (
        <button
          data-testid="reload"
          onClick={() => setPrompt(makePrompt(reloadContent))}
          style={{ position: 'fixed', bottom: 8, right: 8 }}
        />
      )}
    </div>
  );
}
