import { useState, useCallback, useEffect, useRef, Fragment } from 'react';
import { usePrompts } from './hooks/usePrompts';
import { useSSE } from './hooks/useSSE';
import { useResizable } from './hooks/useResizable';
import { renamePrompt } from './api';
import PromptList from './components/PromptList';
import AddPromptDialog from './components/AddPromptDialog';
import PlaygroundContent from './components/PlaygroundContent';
import { Tab } from './components/Tab';
import type { SSEData } from '../shared/types';

// ─── Tab / Pane model ─────────────────────────────────────────────────────────

interface PromptTab { type: 'prompt'; promptId: string }
type AppTab = PromptTab;

const tabKey = (t: AppTab) => `${t.type}:${t.promptId}`;

interface Pane { id: string; tabs: AppTab[]; activeTabKey: string | null }

let _paneSeq = 0;
const mkPaneId = () => `pane${++_paneSeq}`;
const INIT_PANE = mkPaneId();

// ─── Icons ────────────────────────────────────────────────────────────────────

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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  );
}


function SplitIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="12" y1="3" x2="12" y2="21"/>
    </svg>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { prompts, loading, error, refetch, patchPrompt } = usePrompts();
  const [panes, setPanes] = useState<Pane[]>([{ id: INIT_PANE, tabs: [], activeTabKey: null }]);
  const [focusedPaneId, setFocusedPaneId] = useState(INIT_PANE);
  const [rootPath, setRootPath] = useState('');
  const [activeSection, setActiveSection] = useState<'prompts'>('prompts');
  const [showAddPrompt, setShowAddPrompt] = useState(false);
  const [sectionVisible, setSectionVisible] = useState(true);
  const [dropPaneId, setDropPaneId] = useState<string | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const dirtyTabsRef = useRef<Set<string>>(new Set());

  const sidebar   = useResizable({ initial: { w: 224 }, min: 120, max: 600, storageKey: 'sidebar-width' });
  const paneResize = useResizable({ initial: {}, min: 150, storageKey: 'pane-widths' });

  const contentCardRef = useRef<HTMLDivElement>(null);
  const dragTabRef     = useRef<{ paneId: string; key: string } | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(d => setRootPath(d.rootPath)).catch(() => {});
  }, []);

  const handleSSEMessage = useCallback((data: SSEData) => {
    if (data.type === 'prompt-changed') {
      // FIXME: Delay this for a hot second to debounce multiple rapid changes
      refetch();
    }
  }, [refetch]);
  useSSE(handleSSEMessage);

  // Remove tabs whose prompt ID no longer exists (handles renames and deletions)
  useEffect(() => {
    if (loading) return;
    const ids = new Set(prompts.map(p => p.id));
    setPanes(prev => prev.map(pane => {
      const tabs = pane.tabs.filter(t => ids.has(t.promptId));
      if (tabs.length === pane.tabs.length) return pane;
      const activeStillExists = tabs.some(t => tabKey(t) === pane.activeTabKey);
      return {
        ...pane,
        tabs,
        activeTabKey: activeStillExists ? pane.activeTabKey : (tabs.at(-1) ? tabKey(tabs.at(-1)!) : null),
      };
    }));
  }, [prompts, loading]);

  const handleDirtyChange = useCallback((key: string, dirty: boolean) => {
    setDirtyTabs(prev => {
      const next = new Set(prev);
      dirty ? next.add(key) : next.delete(key);
      dirtyTabsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyTabsRef.current.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // ── Pane operations ──────────────────────────────────────────────────────────

  const handleSelectPrompt = (id: string) => {
    const tab: AppTab = { type: 'prompt', promptId: id };
    const key = tabKey(tab);
    setPanes(prev => prev.map(p => p.id !== focusedPaneId ? p : {
      ...p,
      tabs: p.tabs.some(t => tabKey(t) === key) ? p.tabs : [...p.tabs, tab],
      activeTabKey: key,
    }));
  };

  const handleCloseTab = (paneId: string, key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    handleDirtyChange(key, false);
    setPanes(prev => {
      const pane = prev.find(p => p.id === paneId)!;
      const next = pane.tabs.filter(t => tabKey(t) !== key);
      if (next.length === 0 && prev.length > 1) {
        const remaining = prev.filter(p => p.id !== paneId);
        const idx = prev.findIndex(p => p.id === paneId);
        setFocusedPaneId(remaining[Math.min(idx, remaining.length - 1)].id);
        paneResize.deleteSize(paneId);
        return remaining;
      }
      const idx = pane.tabs.findIndex(t => tabKey(t) === key);
      const nextActive = next[Math.min(idx, next.length - 1)] ? tabKey(next[Math.min(idx, next.length - 1)]) : null;
      return prev.map(p => p.id === paneId ? { ...p, tabs: next, activeTabKey: nextActive } : p);
    });
  };

  const handleSplitPane = (paneId: string) => {
    const newId = mkPaneId();
    // Measure the pane's current rendered width to split evenly
    const el = contentCardRef.current?.querySelector<HTMLElement>(`[data-pane="${paneId}"]`);
    const currentWidth = el?.getBoundingClientRect().width ?? 400;
    const half = Math.max(200, Math.floor(currentWidth / 2));
    paneResize.setSize(paneId, half);
    setPanes(prev => {
      const idx = prev.findIndex(p => p.id === paneId);
      const next = [...prev];
      next.splice(idx + 1, 0, { id: newId, tabs: [], activeTabKey: null });
      return next;
    });
    setFocusedPaneId(newId);
  };

  const handleMoveTab = (fromPaneId: string, key: string, toPaneId: string) => {
    if (fromPaneId === toPaneId) return;
    setPanes(prev => {
      const fromPane = prev.find(p => p.id === fromPaneId)!;
      const tab = fromPane.tabs.find(t => tabKey(t) === key);
      if (!tab) return prev;
      return prev.map(p => {
        if (p.id === fromPaneId) {
          const next = p.tabs.filter(t => tabKey(t) !== key);
          const wasActive = p.activeTabKey === key;
          const idx = p.tabs.findIndex(t => tabKey(t) === key);
          return { ...p, tabs: next, activeTabKey: wasActive ? (next[Math.min(idx, next.length - 1)] ? tabKey(next[Math.min(idx, next.length - 1)]) : null) : p.activeTabKey };
        }
        if (p.id === toPaneId) {
          const alreadyOpen = p.tabs.some(t => tabKey(t) === key);
          return { ...p, tabs: alreadyOpen ? p.tabs : [...p.tabs, tab], activeTabKey: key };
        }
        return p;
      });
    });
    setFocusedPaneId(toPaneId);
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const icloudPrefix = '~/Library/Mobile Documents/com~apple~CloudDocs';
  const tildeRoot   = rootPath.replace(/^\/Users\/[^/]+/, '~');
  const isICloud    = tildeRoot.startsWith(icloudPrefix);
  const displayPath = isICloud ? tildeRoot.slice(icloudPrefix.length) || '/' : tildeRoot;

  const focusedPane      = panes.find(p => p.id === focusedPaneId) ?? panes[0];
  const focusedActiveTab = focusedPane?.tabs.find(t => tabKey(t) === focusedPane.activeTabKey) ?? null;
  const selectedPromptId = focusedActiveTab?.type === 'prompt' ? focusedActiveTab.promptId : null;
  const sidebarWidth     = sidebar.sizes.w;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <div className="app-titlebar">
        <div className="app-titlebar-icon"><AppIcon /></div>
        {rootPath && sectionVisible && (
          <span className="header-path">
            {isICloud && (
              <svg className="icloud-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>
              </svg>
            )}
            {isICloud && <span>iCloud Drive</span>}
            {displayPath && displayPath !== '/' && displayPath}
          </span>
        )}
      </div>

      <div className="app-main">
        <div className="icon-strip">
          <nav className="icon-nav">
            <button
              className={`icon-nav-btn ${activeSection === 'prompts' && sectionVisible ? 'active' : ''}`}
              onClick={() => {
                if (activeSection === 'prompts' && sectionVisible) setSectionVisible(false);
                else { setActiveSection('prompts'); setSectionVisible(true); }
              }}
              title="Prompts"
            >
              <PromptsIcon />
            </button>
          </nav>
        </div>

        <div className="content-area">
          {/* ── Tab header ── */}
          <div className="content-header">
            <div className="content-header-spacer" style={{ width: sectionVisible ? sidebarWidth + 4 : 14 }} />

            {panes.map((pane, idx) => {
              const isLast = idx === panes.length - 1;
              const pw = !isLast ? paneResize.sizes[pane.id] : undefined;
              // When sidebar is hidden the 14px spacer doesn't correspond to any card
              // offset, so subtract it from the first pane's tab bar width to keep
              // all subsequent panes' tab bars flush with their content columns.
              const cornerOffset = !sectionVisible && idx === 0 ? 14 : 0;
              return (
                <Fragment key={pane.id}>
                  {idx > 0 && (
                    <div
                      className="pane-resize-divider"
                      onMouseDown={paneResize.getOnMouseDown(panes[idx - 1].id, paneResize.sizes[panes[idx - 1].id] ?? 200)}
                    />
                  )}
                  <div
                    className={`pane-tabbar${pane.id === dropPaneId ? ' pane-drop-target' : ''}`}
                    style={pw !== undefined ? { width: pw - cornerOffset, flexShrink: 0 } : { flex: 1 }}
                    onDragOver={e => { e.preventDefault(); setDropPaneId(pane.id); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropPaneId(null); }}
                    onDrop={() => { setDropPaneId(null); if (dragTabRef.current) handleMoveTab(dragTabRef.current.paneId, dragTabRef.current.key, pane.id); }}
                  >
                    <div className="pane-tabs-scroll">
                      {pane.tabs.map(tab => {
                        const key = tabKey(tab);
                        const name = tab.type === 'prompt' ? (prompts.find(p => p.id === tab.promptId)?.name ?? tab.promptId) : key;
                        return (
                          <Tab
                            key={key}
                            name={name}
                            active={key === pane.activeTabKey}
                            dirty={dirtyTabs.has(key)}
                            onClick={() => { setFocusedPaneId(pane.id); setPanes(prev => prev.map(p => p.id === pane.id ? { ...p, activeTabKey: key } : p)); }}
                            onClose={e => handleCloseTab(pane.id, key, e)}
                            onDragStart={() => { dragTabRef.current = { paneId: pane.id, key }; }}
                            onDragEnd={() => { dragTabRef.current = null; }}
                          />
                        );
                      })}
                    </div>
                    <button className="tab-split-btn" onClick={() => handleSplitPane(pane.id)} title="Split pane">
                      <SplitIcon />
                    </button>
                  </div>
                </Fragment>
              );
            })}
          </div>

          {/* ── Content card ── */}
          <div className="content-card" ref={contentCardRef}>
            {sectionVisible && (
              <>
                <aside className="section-panel" style={{ width: sidebarWidth }}>
                  {activeSection === 'prompts' && (
                    <PromptList
                      prompts={prompts}
                      selectedId={selectedPromptId}
                      onSelect={handleSelectPrompt}
                      loading={loading}
                      error={error}
                      onAddPrompt={() => setShowAddPrompt(true)}
                      onRenamePrompt={async (promptId, newName) => {
                        const prompt = prompts.find(p => p.id === promptId);
                        if (!prompt) return;
                        const updated = await renamePrompt(prompt, newName).catch(() => null);
                        if (updated) {
                          refetch();
                          handleSelectPrompt(updated.id);
                        }
                      }}
                    />
                  )}
                </aside>
                <div className="resize-handle" onMouseDown={sidebar.getOnMouseDown('w', sidebarWidth)} />
              </>
            )}

            {panes.map((pane, idx) => {
              const isLast = idx === panes.length - 1;
              const pw = !isLast ? paneResize.sizes[pane.id] : undefined;
              return (
                <Fragment key={pane.id}>
                  {idx > 0 && (
                    <div
                      className="resize-handle"
                      onMouseDown={paneResize.getOnMouseDown(panes[idx - 1].id, paneResize.sizes[panes[idx - 1].id] ?? 200)}
                    />
                  )}
                  <main
                    className="main-content"
                    data-pane={pane.id}
                    style={pw !== undefined ? { width: pw, flexShrink: 0 } : { flex: 1 }}
                    onClick={() => setFocusedPaneId(pane.id)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => { if (dragTabRef.current) handleMoveTab(dragTabRef.current.paneId, dragTabRef.current.key, pane.id); }}
                  >
                    {pane.tabs.length === 0 && (
                      <div className="empty-state">
                        {panes.length === 1
                          ? <><h2>Select a prompt to get started</h2><p>Choose a prompt from the list on the left to edit and execute it.</p></>
                          : <p>Open a prompt or drag a tab here</p>}
                      </div>
                    )}
                    {pane.tabs.map(tab => {
                      const key = tabKey(tab);
                      const prompt = prompts.find(p => p.id === tab.promptId) ?? null;
                      if (!prompt) return null;
                      return (
                        <div key={key} style={key === pane.activeTabKey ? { display: 'contents' } : { display: 'none' }}>
                          <PlaygroundContent prompt={prompt} onUpdate={patchPrompt} onDirtyChange={dirty => handleDirtyChange(key, dirty)} />
                        </div>
                      );
                    })}
                  </main>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      {showAddPrompt && (
        <AddPromptDialog
          onClose={() => setShowAddPrompt(false)}
          onCreated={(prompt) => {
            setShowAddPrompt(false);
            refetch();
            handleSelectPrompt(prompt.id);
          }}
        />
      )}
    </div>
  );
}

export default App;
