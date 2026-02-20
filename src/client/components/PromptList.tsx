import type { ParsedPrompt } from '../../shared/types';

interface PromptListProps {
  prompts: ParsedPrompt[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}

function PromptList({ prompts, selectedId, onSelect, loading, error }: PromptListProps) {
  if (loading) {
    return (
      <div className="prompt-list">
        <div className="loading">Loading prompts...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="prompt-list">
        <div className="error">Error: {error}</div>
      </div>
    );
  }

  // Group prompts by file
  const groupedPrompts = prompts.reduce((acc, prompt) => {
    const filePath = prompt.metadata?.filePath || 'Unknown';
    if (!acc[filePath]) {
      acc[filePath] = [];
    }
    acc[filePath].push(prompt);
    return acc;
  }, {} as Record<string, ParsedPrompt[]>);

  return (
    <div className="prompt-list">
      <h2>Prompts</h2>

      {Object.entries(groupedPrompts).map(([filePath, filePrompts]) => (
        <div key={filePath} className="prompt-group">
          <div className="file-path">{filePath.split('/').pop()}</div>

          {filePrompts.map((prompt) => (
            <button
              key={prompt.id}
              className={`prompt-item ${prompt.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(prompt.id)}
            >
              <div className="prompt-name">{prompt.name}</div>
              {prompt.functionParameters.length > 0 && (
                <div className="prompt-signature">
                  ({prompt.functionParameters.map(p => p.name).join(', ')})
                </div>
              )}
            </button>
          ))}
        </div>
      ))}

      {prompts.length === 0 && (
        <div className="empty-message">
          No prompts found. Create a .prompt.ts file to get started.
        </div>
      )}
    </div>
  );
}

export default PromptList;
