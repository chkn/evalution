import { useState, useCallback, useEffect } from 'react';
import { usePrompts } from './hooks/usePrompts';
import { useSSE } from './hooks/useSSE';
import { useResizable } from './hooks/useResizable';
import PromptList from './components/PromptList';
import PlaygroundEditor from './components/PlaygroundEditor';
import PlaygroundExecution from './components/PlaygroundExecution';

function PromptsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  );
}

function App() {
  const { prompts, loading, error, refetch } = usePrompts();
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string>('');
  const [activeSection, setActiveSection] = useState<'prompts'>('prompts');
  const sidebar = useResizable({ initial: 224, min: 120, max: 600, storageKey: 'sidebar-width' });

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => setRootPath(data.rootPath))
      .catch(() => {});
  }, []);

  const handleSSEMessage = useCallback((data: any) => {
    if (data.type === 'prompt-changed') refetch();
  }, [refetch]);

  useSSE(handleSSEMessage);

  const handleSelectPrompt = (id: string) => {
    setOpenTabs(prev => prev.includes(id) ? prev : [...prev, id]);
    setActiveTabId(id);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== id);
      if (id === activeTabId) {
        const idx = prev.indexOf(id);
        setActiveTabId(next[Math.min(idx, next.length - 1)] ?? null);
      }
      return next;
    });
  };

  const activePrompt = prompts.find(p => p.id === activeTabId) ?? null;

  const icloudPrefix = '~/Library/Mobile Documents/com~apple~CloudDocs';
  const tildeRoot = rootPath.replace(/^\/Users\/[^/]+/, '~');
  const isICloud = tildeRoot.startsWith(icloudPrefix);
  const displayPath = isICloud ? tildeRoot.slice(icloudPrefix.length) || '/' : tildeRoot;

  return (
    <div className="app">
      <header className="top-bar">
        <span className="top-bar-logo">Evalution</span>
        {rootPath && (
          <span className="top-bar-path">
            {isICloud && (
              <>
                <svg className="icloud-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
                </svg>
                <span className="icloud-label">iCloud Drive</span>
              </>
            )}
            {displayPath && displayPath !== '/' && displayPath}
          </span>
        )}
      </header>

      <div className="app-body">
        <nav className="icon-nav">
          <button
            className={`icon-nav-btn ${activeSection === 'prompts' ? 'active' : ''}`}
            onClick={() => setActiveSection('prompts')}
            title="Prompts"
          >
            <PromptsIcon />
          </button>
        </nav>

        <aside className="section-panel" style={{ width: sidebar.size }}>
          {activeSection === 'prompts' && (
            <PromptList
              prompts={prompts}
              selectedId={activeTabId}
              onSelect={handleSelectPrompt}
              loading={loading}
              error={error}
              rootPath={rootPath}
            />
          )}
        </aside>

        <div className="resize-handle" onMouseDown={sidebar.onMouseDown} />

        <main className="main-content">
          {openTabs.length > 0 && (
            <div className="tab-bar">
              {openTabs.map(id => {
                const p = prompts.find(pr => pr.id === id);
                return (
                  <button
                    key={id}
                    className={`tab ${id === activeTabId ? 'tab-active' : ''}`}
                    onClick={() => setActiveTabId(id)}
                  >
                    <span className="tab-label">{p?.name ?? id}</span>
                    <span className="tab-close" onClick={e => handleCloseTab(id, e)}>×</span>
                  </button>
                );
              })}
            </div>
          )}

          {activePrompt ? (
            <div className="pg-content">
              <PlaygroundEditor
                key={activeTabId ?? ''}
                prompt={activePrompt}
                onUpdate={refetch}
              />
              <PlaygroundExecution
                key={activeTabId ?? ''}
                prompt={activePrompt}
              />
            </div>
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
