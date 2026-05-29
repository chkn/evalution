import { useState } from 'react';
import { TemplateValueBuilder } from 'ts-proppy/react';
import PlaygroundEditor from '../PlaygroundEditor';
import type { NormalizedPrompt, TemplateValue } from '../../../shared/types';

// Lets tests pass plain template-syntax strings (`"Hello ${name}"`) and have
// them split into string segments + tokens, so trailing-token cursor cases
// can be exercised without constructing arrays inline.
function toTemplateValue(text: string): TemplateValue {
  const builder = new TemplateValueBuilder();
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('${', i);
    if (open === -1) { builder.appendString(text.slice(i)); break; }
    const close = text.indexOf('}', open + 2);
    if (close === -1) { builder.appendString(text.slice(i)); break; }
    builder.appendString(text.slice(i, open));
    builder.appendToken(text.slice(open + 2, close));
    i = close + 1;
  }
  return builder.build();
}

export function makePrompt(content: string): NormalizedPrompt {
  return {
    id: 'test',
    providerId: 'test',
    name: 'test',
    functionParameters: [],
    modelEditable: true,
    system: { kind: 'template', value: [''] },
    systemEditable: true,
    messages: [{ role: 'user', content: { kind: 'template', value: toTemplateValue(content) } }],
    messagesEditable: true,
    modelParameters: [],
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
