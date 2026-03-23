import { useState } from 'react';
import PlaygroundEditor from '../PlaygroundEditor';
import type { ParsedPrompt } from '../../../shared/types';

export function makePrompt(content: string): ParsedPrompt {
  return {
    id: 'test',
    providerId: 'test',
    name: 'test',
    functionParameters: [],
    properties: {
      messages: {
        name: 'messages',
        value: [{ role: 'user', content }],
        isEditable: true,
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
