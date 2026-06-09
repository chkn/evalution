import { useState, useCallback, useEffect, useRef, Fragment } from 'react';
import { usePrompts } from './hooks/usePrompts';
import { useTraces } from './hooks/useTraces';
import { useSSE } from './hooks/useSSE';
import { useResizable } from './hooks/useResizable';
import { renamePrompt } from './api';
import { requireProviderId } from './utils';
import PromptList from './components/PromptList';
import TraceList from './components/TraceList';
import TraceView from './components/TraceView';
import AddPromptDialog from './components/AddPromptDialog';
import PlaygroundContent from './components/PlaygroundContent';
import { TerminalView } from './components/TerminalView';
import { Tab } from './components/Tab';
import { WelcomeWizard } from './components/welcome/WelcomeWizard';
import type { ExecuteResponse, PromptID, SSEData } from '../shared/types';

// ─── Tab / Pane model ─────────────────────────────────────────────────────────

interface PromptTab { type: 'prompt'; providerId: string; promptId: string }
interface TraceTab { type: 'trace'; providerId: string; traceId: string; rootSpanId: string; label: string }
interface WelcomeTab { type: 'welcome' }
interface TerminalTab { type: 'terminal'; id: string; taskId: string; stepId: string; command: string; label: string }
type AppTab = PromptTab | TraceTab | WelcomeTab | TerminalTab;

const WELCOME_TAB_KEY = 'welcome';

const tabKey = (t: AppTab) =>
  t.type === 'prompt' ? `prompt:${t.providerId}:${t.promptId}`
  : t.type === 'trace' ? `trace:${t.providerId}:${t.traceId}`
  : t.type === 'terminal' ? `terminal:${t.id}`
  : WELCOME_TAB_KEY;

let _terminalSeq = 0;

interface Pane { id: string; tabs: AppTab[]; activeTabKey: string | null }

let _paneSeq = 0;
const mkPaneId = () => `pane${++_paneSeq}`;
const INIT_PANE = mkPaneId();

// ─── Icons ────────────────────────────────────────────────────────────────────

function AppIcon() {
  return <img src="/favicon.svg" width="22" height="30" style={{ display: 'block' }} />;
}

function TracesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="14" y2="6"/>
      <line x1="8" y1="12" x2="20" y2="12"/>
      <line x1="6" y1="18" x2="16" y2="18"/>
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


function WelcomeIcon() {
  return <span className="welcome-tab-emoji" role="img" aria-label="Welcome">👋</span>;
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5"/>
      <line x1="12" y1="19" x2="20" y2="19"/>
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
  const { prompts, loading, error, refetch: refetchPrompts, patchPrompt } = usePrompts();
  const { traces, refetch: refetchTraces } = useTraces();
  const [panes, setPanes] = useState<Pane[]>([{ id: INIT_PANE, tabs: [], activeTabKey: null }]);
  const [focusedPaneId, setFocusedPaneId] = useState(INIT_PANE);
  const [rootPath, setRootPath] = useState('');
  const [configured, setConfigured] = useState(false);
  const [activeSection, setActiveSection] = useState<'prompts' | 'traces'>('prompts');
  const [showAddPrompt, setShowAddPrompt] = useState(false);
  const [sectionVisible, setSectionVisible] = useState(true);
  const [dropPaneId, setDropPaneId] = useState<string | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const dirtyTabsRef = useRef<Set<string>>(new Set());
  const prevPromptCount = useRef<number | null>(null);

  const sidebar    = useResizable({ initial: { w: 224 }, min: 120, max: 600, storageKey: 'sidebar-width' });
  const paneResize = useResizable({ initial: {}, min: 150, storageKey: 'pane-widths' });

  const contentCardRef = useRef<HTMLDivElement>(null);
  const dragTabRef     = useRef<{ paneId: string; key: string } | null>(null);

  const refetchConfig = useCallback(() => {
    // `no-store`: this is refetched after the server restarts itself with a new
    // config, and the browser HTTP cache would otherwise hand back the stale
    // pre-config response, leaving the UI stuck in onboarding.
    fetch('/api/config', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { setRootPath(d.rootPath); setConfigured(!!d.configured); })
      .catch(() => {});
  }, []);

  useEffect(() => { refetchConfig(); }, [refetchConfig]);

  const handleSSEMessage = useCallback((data: SSEData) => {
    // FIXME: Delay these for a hot second to debounce multiple rapid changes
    if (data.type === 'prompt-changed') {
      refetchPrompts();
    } else if (data.type === 'trace-changed') {
      refetchTraces();
    }
  }, [refetchPrompts, refetchTraces]);

  // Re-pull config and prompts whenever the SSE stream (re)connects. After the
  // server restarts itself when a config file is created, this is what flips
  // the UI out of onboarding without a manual refresh.
  const handleSSEOpen = useCallback(() => {
    refetchConfig();
    refetchPrompts();
  }, [refetchConfig, refetchPrompts]);

  useSSE(handleSSEMessage, handleSSEOpen);

  // Remove tabs whose prompt ID no longer exists (handles renames and deletions)
  useEffect(() => {
    if (loading) return;
    const ids = new Set(prompts.map(p => `${p.providerId}:${p.id}`));
    setPanes(prev => prev.map(pane => {
      const tabs = pane.tabs.filter(t => t.type !== 'prompt' || ids.has(`${t.providerId}:${t.promptId}`));
      if (tabs.length === pane.tabs.length) return pane;
      const activeStillExists = tabs.some(t => tabKey(t) === pane.activeTabKey);
      return {
        ...pane,
        tabs,
        activeTabKey: activeStillExists ? pane.activeTabKey : (tabs.at(-1) ? tabKey(tabs.at(-1)!) : null),
      };
    }));
  }, [prompts, loading]);

  // First-run onboarding: when a project has no prompts, surface a Welcome tab
  // (collapsing the sidebar); once prompts exist, retire it and reveal the
  // sidebar. Both are derived from the prompt count so the wizard disappears
  // automatically the moment the first prompt is created.
  useEffect(() => {
    if (loading) return;
    setPanes(prev => {
      const hasWelcome = prev.some(pane => pane.tabs.some(t => t.type === 'welcome'));
      if (prompts.length === 0) {
        if (hasWelcome) return prev;
        return prev.map((pane, i) => i === 0
          ? { ...pane, tabs: [{ type: 'welcome' as const }, ...pane.tabs], activeTabKey: WELCOME_TAB_KEY }
          : pane);
      }
      if (!hasWelcome) return prev;
      return prev.map(pane => {
        const tabs = pane.tabs.filter(t => t.type !== 'welcome');
        const activeStillExists = tabs.some(t => tabKey(t) === pane.activeTabKey);
        return {
          ...pane,
          tabs,
          activeTabKey: activeStillExists ? pane.activeTabKey : (tabs.at(-1) ? tabKey(tabs.at(-1)!) : null),
        };
      });
    });

    const prev = prevPromptCount.current;
    if (prompts.length === 0) setSectionVisible(false);
    else if (prev === 0) setSectionVisible(true); // just created the first prompt
    prevPromptCount.current = prompts.length;
  }, [loading, prompts.length]);

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

  const handleSelectPrompt = (providerId: string, id: string) => {
    const tab: AppTab = { type: 'prompt', providerId, promptId: id };
    const key = tabKey(tab);
    setPanes(prev => prev.map(p => p.id !== focusedPaneId ? p : {
      ...p,
      tabs: p.tabs.some(t => tabKey(t) === key) ? p.tabs : [...p.tabs, tab],
      activeTabKey: key,
    }));
  };

  const handleSelectTrace = (providerId: string, traceId: string, label: string) => {
    const tab: AppTab = { type: 'trace', providerId, traceId, rootSpanId: '', label };
    const key = tabKey(tab);
    setPanes(prev => {
      const existing = prev.find(p => p.tabs.some(t => tabKey(t) === key));
      if (existing) {
        setFocusedPaneId(existing.id);
        return prev.map(p => p.id === existing.id ? { ...p, activeTabKey: key } : p);
      }
      return prev.map(p => p.id !== focusedPaneId ? p : {
        ...p,
        tabs: [...p.tabs, tab],
        activeTabKey: key,
      });
    });
  };

  const openTabRightOf = (fromPaneId: string, tab: AppTab) => {
    const key = tabKey(tab);
    setPanes(prev => {
      // If already open anywhere, just focus it.
      const existing = prev.find(p => p.tabs.some(t => tabKey(t) === key));
      if (existing) {
        setFocusedPaneId(existing.id);
        return prev.map(p => p.id === existing.id ? { ...p, activeTabKey: key } : p);
      }

      const idx = prev.findIndex(p => p.id === fromPaneId);
      if (idx < 0) return prev;

      // If there's already another pane, use the adjacent one (prefer right, else left).
      let targetId = prev[idx + 1]?.id ?? prev[idx - 1]?.id;
      let next = prev;
      if (!targetId) {
        // Only pane — create a split.
        const newId = mkPaneId();
        targetId = newId;
        const el = contentCardRef.current?.querySelector<HTMLElement>(`[data-pane="${fromPaneId}"]`);
        const currentWidth = el?.getBoundingClientRect().width ?? 400;
        paneResize.setSize(fromPaneId, Math.max(200, Math.floor(currentWidth / 2)));
        next = [...prev];
        next.splice(idx + 1, 0, { id: newId, tabs: [], activeTabKey: null });
      }

      const targetIdResolved = targetId;
      setFocusedPaneId(targetIdResolved);
      return next.map(p => p.id === targetIdResolved
        ? { ...p, tabs: [...p.tabs, tab], activeTabKey: key }
        : p
      );
    });
  };

  /** Opens an interactive terminal tab (split right) with a setup step queued up. */
  const openTerminalRightOf = (fromPaneId: string, taskId: string, stepId: string, command: string, label?: string) => {
    const tab: TerminalTab = { type: 'terminal', id: `t${++_terminalSeq}`, taskId, stepId, command, label: label ?? command };
    openTabRightOf(fromPaneId, tab);
  };

  const openPromptTabRightOf = (fromPaneId: string, prompt: PromptID) => {
    // `prompt` comes from a resolved span, so `providerId` is set.
    const providerId = requireProviderId(prompt.providerId, `opening prompt ${prompt.id} from trace`);
    const tab: PromptTab = { type: 'prompt', providerId, promptId: prompt.id };
    openTabRightOf(fromPaneId, tab);
  };

  /**
   * Opens a trace tab in a pane to the right of the given prompt pane. If that
   * right-hand pane doesn't exist yet, splits the current pane first.
   */
  const openTraceTabRightOf = (fromPaneId: string, result: ExecuteResponse & { label: string }) => {
    const { tracerProviderId: providerId, traceId, rootSpanId, label } = result;
    const tab: TraceTab = { type: 'trace', providerId, traceId, rootSpanId, label };
    openTabRightOf(fromPaneId, tab);
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

      const nextFromTabs = fromPane.tabs.filter(t => tabKey(t) !== key);
      if (nextFromTabs.length === 0 && prev.length > 1) {
        paneResize.deleteSize(fromPaneId);
        const remaining = prev.filter(p => p.id !== fromPaneId);
        return remaining.map(p => {
          if (p.id === toPaneId) {
            const alreadyOpen = p.tabs.some(t => tabKey(t) === key);
            return { ...p, tabs: alreadyOpen ? p.tabs : [...p.tabs, tab], activeTabKey: key };
          }
          return p;
        });
      }

      return prev.map(p => {
        if (p.id === fromPaneId) {
          const wasActive = p.activeTabKey === key;
          const idx = p.tabs.findIndex(t => tabKey(t) === key);
          return { ...p, tabs: nextFromTabs, activeTabKey: wasActive ? (nextFromTabs[Math.min(idx, nextFromTabs.length - 1)] ? tabKey(nextFromTabs[Math.min(idx, nextFromTabs.length - 1)]) : null) : p.activeTabKey };
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
  const pathLabel   = isICloud ? `iCloud Drive${displayPath !== '/' ? displayPath : ''}` : displayPath;

  useEffect(() => {
    if (!rootPath) return;
    document.title = pathLabel;
  }, [pathLabel]);

  const focusedPane      = panes.find(p => p.id === focusedPaneId) ?? panes[0];
  const focusedActiveTab = focusedPane?.tabs.find(t => tabKey(t) === focusedPane.activeTabKey) ?? null;
  const selectedPromptId = focusedActiveTab?.type === 'prompt' ? focusedActiveTab.promptId : null;
  const selectedTraceKey = focusedActiveTab?.type === 'trace'
    ? `${focusedActiveTab.providerId}:${focusedActiveTab.traceId}`
    : null;
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
            <button
              className={`icon-nav-btn ${activeSection === 'traces' && sectionVisible ? 'active' : ''}`}
              onClick={() => {
                if (activeSection === 'traces' && sectionVisible) setSectionVisible(false);
                else { setActiveSection('traces'); setSectionVisible(true); }
              }}
              title="Traces"
            >
              <TracesIcon />
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
                        const name = tab.type === 'prompt'
                          ? (prompts.find(p => p.id === tab.promptId && p.providerId === tab.providerId)?.name ?? tab.promptId)
                          : tab.type === 'trace' ? tab.label
                          : tab.type === 'terminal' ? tab.label
                          : 'Welcome';
                        const icon = tab.type === 'trace' ? <TracesIcon />
                          : tab.type === 'welcome' ? <WelcomeIcon />
                          : tab.type === 'terminal' ? <TerminalIcon />
                          : undefined;
                        return (
                          <Tab
                            key={key}
                            name={name}
                            icon={icon}
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
                          refetchPrompts();
                          handleSelectPrompt(requireProviderId(updated.providerId ?? prompt.providerId, `selecting renamed prompt ${updated.id}`), updated.id);
                        }
                      }}
                    />
                  )}
                  {activeSection === 'traces' && (
                    <TraceList
                      traces={traces}
                      loading={false}
                      error={null}
                      selectedTraceKey={selectedTraceKey}
                      onSelect={(t) => handleSelectTrace(t.providerId, t.id, t.name)}
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
                        <img src="/favicon.svg" style={{ width: 96, height: 96, opacity: 0.18 }} />
                      </div>
                    )}
                    {pane.tabs.map(tab => {
                      const key = tabKey(tab);
                      const visible = key === pane.activeTabKey ? { display: 'contents' } : { display: 'none' };
                      if (tab.type === 'welcome') {
                        return (
                          <div key={key} style={visible}>
                            <WelcomeWizard
                              configured={configured}
                              onCreatePrompt={() => setShowAddPrompt(true)}
                              onOpenTerminal={(taskId, stepId, command, label) => openTerminalRightOf(pane.id, taskId, stepId, command, label)}
                            />
                          </div>
                        );
                      }
                      if (tab.type === 'terminal') {
                        return (
                          <div key={key} style={visible}>
                            <TerminalView taskId={tab.taskId} stepId={tab.stepId} command={tab.command} />
                          </div>
                        );
                      }
                      if (tab.type === 'prompt') {
                        const prompt = prompts.find(p => p.id === tab.promptId && p.providerId === tab.providerId) ?? null;
                        if (!prompt) return null;
                        return (
                          <div key={key} style={visible}>
                            <PlaygroundContent
                              prompt={prompt}
                              onUpdate={patchPrompt}
                              onDirtyChange={dirty => handleDirtyChange(key, dirty)}
                              onExecuted={(result) =>
                                openTraceTabRightOf(pane.id, result)}
                            />
                          </div>
                        );
                      }
                      return (
                        <div key={key} style={visible}>
                          <TraceView providerId={tab.providerId} traceId={tab.traceId} initialSpanId={tab.rootSpanId || undefined} onOpenPrompt={(prompt) => openPromptTabRightOf(pane.id, prompt)} />
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
            refetchPrompts();
            handleSelectPrompt(requireProviderId(prompt.providerId, `selecting created prompt ${prompt.id}`), prompt.id);
          }}
        />
      )}
    </div>
  );
}

export default App;
