import { useState } from 'react';
import PlaygroundEditor from '../PlaygroundEditor';
import type { NormalizedPrompt } from '../../../shared/types';

export function makePrompt(content: string): NormalizedPrompt {
  return {
    id: 'test',
    providerId: 'test',
    name: 'test',
    functionParameters: [],
    modelEditable: true,
    systemEditable: true,
    messages: [{ role: 'user', content }],
    messagesEditable: true,
    parameters: [],
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
  const [prompt, setPrompt] = useState<NormalizedPrompt>(makePrompt(initialContent));

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
