import { useState } from 'react';
import PlaygroundContent from '../PlaygroundContent';
import type { NormalizedPrompt, NormalizedMessage } from '../../../shared/types';

function makePrompt(messagesCount: number): NormalizedPrompt {
  const messages: NormalizedMessage[] = Array.from({ length: messagesCount }, (_, i) => ({
    role: 'user',
    content: `Message ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
  }));
  return {
    id: 'test',
    providerId: 'test',
    name: 'test',
    functionParameters: [],
    modelEditable: true,
    systemEditable: true,
    messages,
    messagesEditable: true,
    modelParameters: [],
  };
}

/**
 * Mounts PlaygroundContent inside a fixed-size `.main-content` so tests can
 * assert the single-vs-multi-column layout switch at controlled dimensions.
 */
export function PlaygroundContentHarness({
  width,
  height,
  messagesCount,
}: {
  width: number;
  height: number;
  messagesCount: number;
}) {
  const [prompt, setPrompt] = useState<NormalizedPrompt>(makePrompt(messagesCount));
  return (
    <div className="main-content" style={{ width, height }}>
      <PlaygroundContent
        prompt={prompt}
        onUpdate={setPrompt}
        onDirtyChange={() => {}}
      />
    </div>
  );
}
