import { useState, useCallback, useEffect } from 'react';
import { usePrompts } from './hooks/usePrompts';
import { useSSE } from './hooks/useSSE';
import { useResizable } from './hooks/useResizable';
import PromptList from './components/PromptList';
import PlaygroundEditor from './components/PlaygroundEditor';
import PlaygroundExecution from './components/PlaygroundExecution';

// ─── Tab type abstraction ────────────────────────────────────────────────────

interface PromptTab { type: 'prompt'; promptId: string }
type AppTab = PromptTab;

const tabKey = (t: AppTab) => `${t.type}:${t.promptId}`;

// ─── Icons ───────────────────────────────────────────────────────────────────

function AppIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5"/>
      <line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
  );
}

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

function PromptTabIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const { prompts, loading, error, refetch } = usePrompts();
  const [openTabs, setOpenTabs] = useState<AppTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
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
    const tab: AppTab = { type: 'prompt', promptId: id };
    const key = tabKey(tab);
    setOpenTabs(prev => prev.some(t => tabKey(t) === key) ? prev : [...prev, tab]);
    setActiveTabKey(key);
  };

  const handleCloseTab = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter(t => tabKey(t) !== key);
      if (key === activeTabKey) {
        const idx = prev.findIndex(t => tabKey(t) === key);
        setActiveTabKey(next[Math.min(idx, next.length - 1)] ? tabKey(next[Math.min(idx, next.length - 1)]) : null);
      }
      return next;
    });
  };

  const activeTab = openTabs.find(t => tabKey(t) === activeTabKey) ?? null;

  const icloudPrefix = '~/Library/Mobile Documents/com~apple~CloudDocs';
  const tildeRoot = rootPath.replace(/^\/Users\/[^/]+/, '~');
  const isICloud = tildeRoot.startsWith(icloudPrefix);
  const displayPath = isICloud ? tildeRoot.slice(icloudPrefix.length) || '/' : tildeRoot;

  const selectedPromptId = activeTab?.type === 'prompt' ? activeTab.promptId : null;

  return (
    <div className="app">
      {/* Full-width title bar: app icon + working directory */}
      <div className="app-titlebar">
        <div className="app-titlebar-icon">
          <AppIcon />
        </div>
        {rootPath && (
          <span className="header-path">
            {isICloud && (
              <svg className="icloud-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
              </svg>
            )}
            {isICloud && <span>iCloud Drive</span>}
            {displayPath && displayPath !== '/' && displayPath}
          </span>
        )}
      </div>

      {/* Main area: icon nav + content */}
      <div className="app-main">
        <div className="icon-strip">
          <nav className="icon-nav">
            <button
              className={`icon-nav-btn ${activeSection === 'prompts' ? 'active' : ''}`}
              onClick={() => setActiveSection('prompts')}
              title="Prompts"
            >
              <PromptsIcon />
            </button>
          </nav>
        </div>

        <div className="content-area">
          {/* Tabs aligned to main content column via spacer */}
          <div className="content-header">
            <div className="content-header-spacer" style={{ width: sidebar.size + 4 }} />
            {openTabs.map(tab => {
              const key = tabKey(tab);
              const name = tab.type === 'prompt'
                ? (prompts.find(p => p.id === tab.promptId)?.name ?? tab.promptId)
                : key;
              return (
                <button
                  key={key}
                  className={`tab ${key === activeTabKey ? 'tab-active' : ''}`}
                  onClick={() => setActiveTabKey(key)}
                >
                  <span className="tab-icon"><PromptTabIcon /></span>
                  <span className="tab-label">{name}</span>
                  <span className="tab-close" onClick={e => handleCloseTab(key, e)}>×</span>
                </button>
              );
            })}
          </div>

          <div className="content-card">
            <aside className="section-panel" style={{ width: sidebar.size }}>
              {activeSection === 'prompts' && (
                <PromptList
                  prompts={prompts}
                  selectedId={selectedPromptId}
                  onSelect={handleSelectPrompt}
                  loading={loading}
                  error={error}
                  rootPath={rootPath}
                />
              )}
            </aside>

            <div className="resize-handle" onMouseDown={sidebar.onMouseDown} />

            <main className="main-content">
              {openTabs.length === 0 && (
                <div className="empty-state">
                  <h2>Select a prompt to get started</h2>
                  <p>Choose a prompt from the list on the left to edit and execute it.</p>
                </div>
              )}
              {openTabs.map(tab => {
                const key = tabKey(tab);
                const prompt = prompts.find(p => p.id === tab.promptId) ?? null;
                if (!prompt) return null;
                return (
                  <div key={key} style={key === activeTabKey ? { display: 'contents' } : { display: 'none' }}>
                    <div className="pg-content">
                      <PlaygroundEditor prompt={prompt} onUpdate={refetch} />
                      <PlaygroundExecution prompt={prompt} />
                    </div>
                  </div>
                );
              })}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
