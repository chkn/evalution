import { useState, useCallback } from 'react';
import { usePrompts } from './hooks/usePrompts';
import { useSSE } from './hooks/useSSE';
import PromptList from './components/PromptList';
import PromptEditor from './components/PromptEditor';
import ExecutionPanel from './components/ExecutionPanel';

function App() {
  const { prompts, loading, error, refetch } = usePrompts();
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);

  // Handle SSE messages for hot reload
  const handleSSEMessage = useCallback((data: any) => {
    if (data.type === 'prompt-changed') {
      refetch();
    }
  }, [refetch]);

  useSSE(handleSSEMessage);

  const selectedPrompt = prompts.find(p => p.id === selectedPromptId) || null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>✨ Evalution</h1>
        <p>AI Prompt Playground</p>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <PromptList
            prompts={prompts}
            selectedId={selectedPromptId}
            onSelect={setSelectedPromptId}
            loading={loading}
            error={error}
          />
        </aside>

        <main className="main-content">
          {selectedPrompt ? (
            <>
              <PromptEditor
                prompt={selectedPrompt}
                onUpdate={refetch}
              />
              <ExecutionPanel
                prompt={selectedPrompt}
              />
            </>
          ) : (
            <div className="empty-state">
              <h2>Select a prompt to get started</h2>
              <p>Choose a prompt from the list on the left to edit and execute it.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
