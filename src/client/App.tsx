// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { samePrompt } from "../shared/dataset-fields";
import type {
  ExecuteResponse,
  NormalizedPrompt,
  PromptID,
  PromptRef,
  SSEData,
} from "../shared/types";
import { renamePrompt } from "./api";
import AddPromptDialog from "./components/AddPromptDialog";
import DatasetList, { datasetKey } from "./components/DatasetList";
import {
  fromTrace,
  hasRecordedInputs,
  type PanelFill,
  type PanelFillSource,
  panelFill,
} from "./components/named-inputs";
import PlaygroundContent from "./components/PlaygroundContent";
import PromptList from "./components/PromptList";
import SettingsList, {
  type SettingsSection,
  settingsSectionLabel,
} from "./components/SettingsList";
import SettingsView from "./components/SettingsView";
import { Tab } from "./components/Tab";
import { TerminalView } from "./components/TerminalView";
import TraceList from "./components/TraceList";
import TraceView from "./components/TraceView";
import { DatasetsIcon as DatasetsGlyph } from "./components/trace/icons.tsx";
import { WelcomeWizard } from "./components/welcome/WelcomeWizard";
import { useDatasets } from "./hooks/useDatasets";
import { usePrompts } from "./hooks/usePrompts";
import { useResizable } from "./hooks/useResizable";
import { useSSE } from "./hooks/useSSE";
import { useTraces } from "./hooks/useTraces";
import { consumeSelfEdit } from "./self-edits";
import { requireProviderId, withSetMembership } from "./utils";

/**
 * Loaded on first use: its data grid is sizeable, and most sessions never
 * open a dataset.
 */
const DatasetView = lazy(() => import("./components/DatasetView"));

// ─── Tab / Pane model ─────────────────────────────────────────────────────────

interface PromptTab {
  type: "prompt";
  providerId: string;
  promptId: string;
  /** A one-shot request to fill the execute panel — see `PanelFill`. */
  fill?: PanelFill;
  /**
   * The version or variation the tab shows instead of head, if any. Head's
   * unsaved edits aren't one — see `PlaygroundContent`'s `promptRef`.
   */
  ref?: PromptRef;
}
interface TraceTab {
  type: "trace";
  providerId: string;
  traceId: string;
  rootSpanId: string;
  label: string;
}
interface DatasetTab {
  type: "dataset";
  providerId: string;
  datasetId: string;
  label: string;
}
interface WelcomeTab {
  type: "welcome";
}
interface SettingsTab {
  type: "settings";
  section: SettingsSection;
}
interface TerminalTab {
  type: "terminal";
  id: string;
  taskId: string;
  stepId: string;
  command: string;
  label: string;
}
type AppTab =
  | PromptTab
  | TraceTab
  | DatasetTab
  | WelcomeTab
  | TerminalTab
  | SettingsTab;

const WELCOME_TAB_KEY = "welcome";

const tabKey = (t: AppTab) =>
  t.type === "prompt"
    ? `prompt:${t.providerId}:${t.promptId}`
    : t.type === "trace"
      ? `trace:${t.providerId}:${t.traceId}`
      : t.type === "dataset"
        ? `dataset:${t.providerId}:${t.datasetId}`
        : t.type === "terminal"
          ? `terminal:${t.id}`
          : t.type === "settings"
            ? `settings:${t.section}`
            : WELCOME_TAB_KEY;

let _terminalSeq = 0;

interface Pane {
  id: string;
  tabs: AppTab[];
  activeTabKey: string | null;
}

let _paneSeq = 0;
const mkPaneId = () => `pane${++_paneSeq}`;
const INIT_PANE = mkPaneId();

/** How long a pane stays flagged `.pane-flash` after `flashPane` lands on it. */
const PANE_FLASH_MS = 1200;

/**
 * Scrolls the pane `paneId` into view and briefly flashes it — what
 * refocusing an already-open, already-visible pane (a "trace ↗" / "dataset
 * ↗" link in a filled panel's notice, say) does to read as "here it is",
 * not just a silent focus change nothing else about the screen shows.
 */
function flashPane(paneId: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-pane="${CSS.escape(paneId)}"]`,
  );
  if (!el) return;
  el.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest",
  });
  // Restart-safe, as in `SourceRow.tsx`'s `scrollToRow`: removing the class
  // and forcing a reflow before adding it back makes a repeat click flash
  // again instead of no-op-ing into an animation already in flight.
  el.classList.remove("pane-flash");
  void el.offsetWidth;
  el.classList.add("pane-flash");
  window.setTimeout(() => el.classList.remove("pane-flash"), PANE_FLASH_MS);
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function AppIcon() {
  return (
    <img
      src="/favicon.svg"
      width="22"
      height="30"
      alt="evalution logo"
      style={{ display: "block" }}
    />
  );
}

function TracesIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="6" y1="18" x2="16" y2="18" />
    </svg>
  );
}

function DatasetsIcon() {
  return <DatasetsGlyph size={20} />;
}

function PromptsIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function WelcomeIcon() {
  return (
    <span className="welcome-tab-emoji" role="img" aria-label="Welcome">
      👋
    </span>
  );
}

function TerminalIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const {
    prompts,
    loading,
    error,
    refetch: refetchPrompts,
    patchPrompt,
  } = usePrompts();
  const { traces, refetch: refetchTraces } = useTraces();
  const {
    datasets,
    loading: datasetsLoading,
    error: datasetsError,
    refetch: refetchDatasets,
  } = useDatasets();
  // Bumped on every dataset change event, so open dataset views refetch.
  const [datasetVersion, setDatasetVersion] = useState(0);
  // Bumped on every prompt change made elsewhere, so a tab showing a version
  // or variation re-reads it.
  const [promptsVersion, setPromptsVersion] = useState(0);
  const [panes, setPanes] = useState<Pane[]>([
    { id: INIT_PANE, tabs: [], activeTabKey: null },
  ]);
  const [focusedPaneId, setFocusedPaneId] = useState(INIT_PANE);
  const [rootPath, setRootPath] = useState("");
  const [configured, setConfigured] = useState(false);
  const [activeSection, setActiveSection] = useState<
    "prompts" | "traces" | "datasets" | "settings"
  >("prompts");
  const [showAddPrompt, setShowAddPrompt] = useState(false);
  const [sectionVisible, setSectionVisible] = useState(
    // `?expand=true` opens with the sidebar collapsed — handy when embedding a
    // single prompt (e.g. evalution running inside an iframe on another page).
    () => new URLSearchParams(window.location.search).get("expand") !== "true",
  );
  const [dropPaneId, setDropPaneId] = useState<string | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const dirtyTabsRef = useRef<Set<string>>(new Set());
  const prevPromptCount = useRef<number | null>(null);
  // One-shot deep link: `?prompt=<id>` opens that prompt once it has loaded.
  const didDeepLink = useRef(false);

  const sidebar = useResizable({
    initial: { w: 224 },
    min: 120,
    max: 600,
    storageKey: "sidebar-width",
  });
  const paneResize = useResizable({
    initial: {},
    min: 150,
    storageKey: "pane-widths",
  });

  const contentCardRef = useRef<HTMLDivElement>(null);
  const dragTabRef = useRef<{ paneId: string; key: string } | null>(null);

  const refetchConfig = useCallback(() => {
    // `no-store`: this is refetched after the server restarts itself with a new
    // config, and the browser HTTP cache would otherwise hand back the stale
    // pre-config response, leaving the UI stuck in onboarding.
    fetch("/api/config", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setRootPath(d.rootPath);
        setConfigured(!!d.configured);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refetchConfig();
  }, [refetchConfig]);

  const handleSSEMessage = useCallback(
    (data: SSEData) => {
      // FIXME: Delay these for a hot second to debounce multiple rapid changes
      if (data.type === "prompt-changed") {
        // Skip echoes of this client's own edits — local state is already
        // patched, and re-fetching would reset editor cursor position. Edits
        // from other clients (e.g. another tab) aren't marked, so they refetch.
        if (
          consumeSelfEdit(data.event.type, data.providerId, data.event.promptId)
        )
          return;
        refetchPrompts();
        setPromptsVersion(v => v + 1);
      } else if (data.type === "trace-changed") {
        refetchTraces();
      } else if (data.type === "dataset-changed") {
        refetchDatasets();
        setDatasetVersion(v => v + 1);
      }
    },
    [refetchPrompts, refetchTraces, refetchDatasets],
  );

  // Re-pull everything the change events would have carried whenever the SSE
  // stream (re)connects. After the server restarts itself when a config file is
  // created, this is what flips the UI out of onboarding without a manual
  // refresh; after a dropped connection it's what closes the gap, since every
  // event sent while the stream was down is simply gone.
  const handleSSEOpen = useCallback(() => {
    refetchConfig();
    refetchPrompts();
    refetchTraces();
    refetchDatasets();
  }, [refetchConfig, refetchPrompts, refetchTraces, refetchDatasets]);

  useSSE(handleSSEMessage, handleSSEOpen);

  // Remove tabs whose prompt ID no longer exists (handles renames and deletions)
  useEffect(() => {
    if (loading) return;
    const ids = new Set(prompts.map(p => `${p.providerId}:${p.id}`));
    setPanes(prev =>
      prev.map(pane => {
        const tabs = pane.tabs.filter(
          t => t.type !== "prompt" || ids.has(`${t.providerId}:${t.promptId}`),
        );
        if (tabs.length === pane.tabs.length) return pane;
        const activeStillExists = tabs.some(
          t => tabKey(t) === pane.activeTabKey,
        );
        return {
          ...pane,
          tabs,
          activeTabKey: activeStillExists
            ? pane.activeTabKey
            : tabs.at(-1)
              ? tabKey(tabs.at(-1)!)
              : null,
        };
      }),
    );
  }, [prompts, loading]);

  // First-run onboarding: when a project has no prompts, surface a Welcome tab
  // (collapsing the sidebar); once prompts exist, retire it and reveal the
  // sidebar. Both are derived from the prompt count so the wizard disappears
  // automatically the moment the first prompt is created.
  useEffect(() => {
    if (loading) return;
    setPanes(prev => {
      const hasWelcome = prev.some(pane =>
        pane.tabs.some(t => t.type === "welcome"),
      );
      if (prompts.length === 0) {
        if (hasWelcome) return prev;
        return prev.map((pane, i) =>
          i === 0
            ? {
                ...pane,
                tabs: [{ type: "welcome" as const }, ...pane.tabs],
                activeTabKey: WELCOME_TAB_KEY,
              }
            : pane,
        );
      }
      if (!hasWelcome) return prev;
      return prev.map(pane => {
        const tabs = pane.tabs.filter(t => t.type !== "welcome");
        const activeStillExists = tabs.some(
          t => tabKey(t) === pane.activeTabKey,
        );
        return {
          ...pane,
          tabs,
          activeTabKey: activeStillExists
            ? pane.activeTabKey
            : tabs.at(-1)
              ? tabKey(tabs.at(-1)!)
              : null,
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
      const next = withSetMembership(prev, key, dirty);
      dirtyTabsRef.current = next;
      return next;
    });
  }, []);

  // Only edits still in flight are lost by leaving: unsaved edits that
  // reached the server (a prompt's `dirty`) are still there on return.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyTabsRef.current.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ── Pane operations ──────────────────────────────────────────────────────────

  /** Points the prompt tab `key` at `ref` (head for `undefined`), wherever it is. */
  const setPromptTabRef = useCallback(
    (key: string, ref: PromptRef | undefined) => {
      setPanes(prev =>
        prev.map(pane =>
          pane.tabs.some(t => tabKey(t) === key)
            ? {
                ...pane,
                tabs: pane.tabs.map(t => {
                  if (tabKey(t) !== key || t.type !== "prompt") return t;
                  const { ref: _, ...rest } = t;
                  return ref ? { ...rest, ref } : rest;
                }),
              }
            : pane,
        ),
      );
    },
    [],
  );

  const handleSelectPrompt = (providerId: string, id: string) => {
    const tab: AppTab = { type: "prompt", providerId, promptId: id };
    const key = tabKey(tab);
    setPanes(prev =>
      prev.map(p =>
        p.id !== focusedPaneId
          ? p
          : {
              ...p,
              tabs: p.tabs.some(t => tabKey(t) === key)
                ? p.tabs
                : [...p.tabs, tab],
              activeTabKey: key,
            },
      ),
    );
  };

  // Open the prompt named by `?prompt=<id>` (its {@link NormalizedPrompt.id})
  // once prompts have loaded, exactly once. Matches on id alone so callers don't
  // need to know the provider id.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one shot
  useEffect(() => {
    if (loading || didDeepLink.current) return;
    const target = new URLSearchParams(window.location.search).get("prompt");
    const match = target ? prompts.find(p => p.id === target) : undefined;
    if (match?.providerId) handleSelectPrompt(match.providerId, match.id);
    didDeepLink.current = true;
  }, [loading, prompts]);

  /**
   * Opens `tab` in the focused pane — what picking a trace or dataset in the
   * sidebar does. A tab already open anywhere is focused instead.
   */
  const openTabInFocusedPane = (tab: AppTab) => {
    const key = tabKey(tab);
    setPanes(prev => {
      const existing = prev.find(p => p.tabs.some(t => tabKey(t) === key));
      if (existing) {
        setFocusedPaneId(existing.id);
        flashPane(existing.id);
        return prev.map(p =>
          p.id === existing.id ? { ...p, activeTabKey: key } : p,
        );
      }
      return prev.map(p =>
        p.id !== focusedPaneId
          ? p
          : {
              ...p,
              tabs: [...p.tabs, tab],
              activeTabKey: key,
            },
      );
    });
  };

  /**
   * @param replace - Whether an already-open copy of the tab is replaced by
   *   `tab` rather than just focused — how a fresh `fill` reaches a prompt tab
   *   that's already open.
   */
  const openTabRightOf = (fromPaneId: string, tab: AppTab, replace = false) => {
    const key = tabKey(tab);
    setPanes(prev => {
      // If already open anywhere, just focus it.
      const existing = prev.find(p => p.tabs.some(t => tabKey(t) === key));
      if (existing) {
        setFocusedPaneId(existing.id);
        flashPane(existing.id);
        return prev.map(p =>
          p.id === existing.id
            ? {
                ...p,
                tabs: replace
                  ? p.tabs.map(t => (tabKey(t) === key ? tab : t))
                  : p.tabs,
                activeTabKey: key,
              }
            : p,
        );
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
        const el = contentCardRef.current?.querySelector<HTMLElement>(
          `[data-pane="${fromPaneId}"]`,
        );
        const currentWidth = el?.getBoundingClientRect().width ?? 400;
        paneResize.setSize(
          fromPaneId,
          Math.max(200, Math.floor(currentWidth / 2)),
        );
        next = [...prev];
        next.splice(idx + 1, 0, { id: newId, tabs: [], activeTabKey: null });
      }

      const targetIdResolved = targetId;
      setFocusedPaneId(targetIdResolved);
      return next.map(p =>
        p.id === targetIdResolved
          ? { ...p, tabs: [...p.tabs, tab], activeTabKey: key }
          : p,
      );
    });
  };

  /** Opens an interactive terminal tab (split right) with a setup step queued up. */
  const openTerminalRightOf = (
    fromPaneId: string,
    taskId: string,
    stepId: string,
    command: string,
    label?: string,
  ) => {
    const tab: TerminalTab = {
      type: "terminal",
      id: `t${++_terminalSeq}`,
      taskId,
      stepId,
      command,
      label: label ?? command,
    };
    openTabRightOf(fromPaneId, tab);
  };

  /** The loaded prompt a provider-scoped reference names, if any. */
  const findPrompt = (ref: PromptID): NormalizedPrompt | undefined =>
    prompts.find(p => samePrompt(p, ref));

  /**
   * Opens a prompt tab to the right, optionally carrying a `fill` for its
   * execute panel. An already-open tab gets the new fill (with its fresh
   * nonce) and focus.
   */
  const openPromptTabRightOf = (
    fromPaneId: string,
    prompt: Pick<PromptID, "id" | "providerId">,
    fill?: PanelFill,
    ref?: PromptRef,
  ) => {
    // `prompt` comes from a resolved span or dataset, so `providerId` is set.
    const providerId = requireProviderId(
      prompt.providerId,
      `opening prompt ${prompt.id}`,
    );
    const tab: PromptTab = {
      type: "prompt",
      providerId,
      promptId: prompt.id,
      ...(fill && { fill }),
      ...(ref && { ref }),
    };
    openTabRightOf(fromPaneId, tab, !!fill || !!ref);
  };

  /** "Open prompt" on a trace: open it with the panel filled from the trace's inputs. */
  const openPromptFromTrace = (
    fromPaneId: string,
    recorded: PromptID,
    traceId: string,
    traceProviderId: string,
  ) => {
    const current = findPrompt(recorded);
    const fill =
      current && hasRecordedInputs(recorded)
        ? panelFill(fromTrace(recorded, current), current, {
            type: "trace",
            description: `trace ${traceId.slice(0, 8)}…`,
            providerId: traceProviderId,
            traceId,
          })
        : undefined;
    // At the variation the run applied, else the version it ran against —
    // the server opens head when that version is what's on disk now.
    const ref: PromptRef | undefined = recorded.variation
      ? { promptId: recorded.id, variation: recorded.variation }
      : recorded.version
        ? { promptId: recorded.id, version: recorded.version }
        : undefined;
    openPromptTabRightOf(
      fromPaneId,
      { id: recorded.id, providerId: recorded.providerId },
      fill,
      ref,
    );
  };

  const traceTab = (providerId: string, traceId: string): TraceTab => ({
    type: "trace",
    providerId,
    traceId,
    rootSpanId: "",
    label:
      traces.find(t => t.id === traceId && t.providerId === providerId)?.name ??
      `trace ${traceId.slice(0, 8)}…`,
  });

  /** A filled panel's "trace ↗" / "dataset ↗": focus the source if open, else open it beside the panel. */
  const openFillSource = (fromPaneId: string, from: PanelFillSource) =>
    openTabRightOf(
      fromPaneId,
      from.type === "trace"
        ? traceTab(from.providerId, from.traceId)
        : {
            type: "dataset",
            providerId: from.providerId,
            datasetId: from.datasetId,
            label: from.name,
          },
    );

  /**
   * Closes every tab with `key`, wherever it is (a deleted dataset's, say) —
   * exactly as clicking each one's close button would.
   */
  const closeTabEverywhere = (key: string) => {
    for (const pane of panes) {
      if (pane.tabs.some(t => tabKey(t) === key)) closeTab(pane.id, key);
    }
  };

  /**
   * Opens a trace tab in a pane to the right of the given prompt pane. If that
   * right-hand pane doesn't exist yet, splits the current pane first.
   */
  const openTraceTabRightOf = (
    fromPaneId: string,
    result: ExecuteResponse & { label: string },
  ) => {
    const { tracerProviderId: providerId, traceId, rootSpanId, label } = result;
    const tab: TraceTab = {
      type: "trace",
      providerId,
      traceId,
      rootSpanId,
      label,
    };
    openTabRightOf(fromPaneId, tab);
  };

  const closeTab = (paneId: string, key: string) => {
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
      const neighbor = next[Math.min(idx, next.length - 1)];
      const nextActive =
        pane.activeTabKey === key
          ? neighbor
            ? tabKey(neighbor)
            : null
          : pane.activeTabKey;
      return prev.map(p =>
        p.id === paneId ? { ...p, tabs: next, activeTabKey: nextActive } : p,
      );
    });
  };

  const handleCloseTab = (paneId: string, key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(paneId, key);
  };

  const handleSplitPane = (paneId: string) => {
    const newId = mkPaneId();
    // Measure the pane's current rendered width to split evenly
    const el = contentCardRef.current?.querySelector<HTMLElement>(
      `[data-pane="${paneId}"]`,
    );
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
            return {
              ...p,
              tabs: alreadyOpen ? p.tabs : [...p.tabs, tab],
              activeTabKey: key,
            };
          }
          return p;
        });
      }

      return prev.map(p => {
        if (p.id === fromPaneId) {
          const wasActive = p.activeTabKey === key;
          const idx = p.tabs.findIndex(t => tabKey(t) === key);
          return {
            ...p,
            tabs: nextFromTabs,
            activeTabKey: wasActive
              ? nextFromTabs[Math.min(idx, nextFromTabs.length - 1)]
                ? tabKey(nextFromTabs[Math.min(idx, nextFromTabs.length - 1)])
                : null
              : p.activeTabKey,
          };
        }
        if (p.id === toPaneId) {
          const alreadyOpen = p.tabs.some(t => tabKey(t) === key);
          return {
            ...p,
            tabs: alreadyOpen ? p.tabs : [...p.tabs, tab],
            activeTabKey: key,
          };
        }
        return p;
      });
    });
    setFocusedPaneId(toPaneId);
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const icloudPrefix = "~/Library/Mobile Documents/com~apple~CloudDocs";
  const tildeRoot = rootPath.replace(/^\/Users\/[^/]+/, "~");
  const isICloud = tildeRoot.startsWith(icloudPrefix);
  const displayPath = isICloud
    ? tildeRoot.slice(icloudPrefix.length) || "/"
    : tildeRoot;
  const pathLabel = isICloud
    ? `iCloud Drive${displayPath !== "/" ? displayPath : ""}`
    : displayPath;

  useEffect(() => {
    if (!rootPath) return;
    document.title = pathLabel;
  }, [pathLabel, rootPath]);

  const focusedPane = panes.find(p => p.id === focusedPaneId) ?? panes[0];
  const focusedActiveTab =
    focusedPane?.tabs.find(t => tabKey(t) === focusedPane.activeTabKey) ?? null;
  const selectedPromptId =
    focusedActiveTab?.type === "prompt" ? focusedActiveTab.promptId : null;
  const selectedTraceKey =
    focusedActiveTab?.type === "trace"
      ? `${focusedActiveTab.providerId}:${focusedActiveTab.traceId}`
      : null;
  const selectedDatasetKey =
    focusedActiveTab?.type === "dataset"
      ? datasetKey({
          providerId: focusedActiveTab.providerId,
          id: focusedActiveTab.datasetId,
        })
      : null;
  const selectedSettingsSection =
    focusedActiveTab?.type === "settings" ? focusedActiveTab.section : null;
  const sidebarWidth = sidebar.sizes.w;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <div className="app-titlebar">
        <div className="app-titlebar-icon">
          <AppIcon />
        </div>
        {rootPath && sectionVisible && (
          <span className="header-path">
            {isICloud && (
              <svg
                className="icloud-icon"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
              </svg>
            )}
            {isICloud && <span>iCloud Drive</span>}
            {displayPath && displayPath !== "/" && displayPath}
          </span>
        )}
      </div>

      <div className="app-main">
        <div className="icon-strip">
          <nav className="icon-nav">
            <button
              type="button"
              className={`icon-nav-btn ${activeSection === "prompts" && sectionVisible ? "active" : ""}`}
              onClick={() => {
                if (activeSection === "prompts" && sectionVisible)
                  setSectionVisible(false);
                else {
                  setActiveSection("prompts");
                  setSectionVisible(true);
                }
              }}
              title="Prompts"
            >
              <PromptsIcon />
            </button>
            <button
              type="button"
              className={`icon-nav-btn ${activeSection === "traces" && sectionVisible ? "active" : ""}`}
              onClick={() => {
                if (activeSection === "traces" && sectionVisible)
                  setSectionVisible(false);
                else {
                  setActiveSection("traces");
                  setSectionVisible(true);
                }
              }}
              title="Traces"
            >
              <TracesIcon />
            </button>
            <button
              type="button"
              className={`icon-nav-btn ${activeSection === "datasets" && sectionVisible ? "active" : ""}`}
              onClick={() => {
                if (activeSection === "datasets" && sectionVisible)
                  setSectionVisible(false);
                else {
                  setActiveSection("datasets");
                  setSectionVisible(true);
                }
              }}
              title="Datasets"
            >
              <DatasetsIcon />
            </button>
          </nav>
          <nav className="icon-nav-bottom">
            <button
              type="button"
              className={`icon-nav-btn ${activeSection === "settings" && sectionVisible ? "active" : ""}`}
              onClick={() => {
                if (activeSection === "settings" && sectionVisible)
                  setSectionVisible(false);
                else {
                  setActiveSection("settings");
                  setSectionVisible(true);
                }
              }}
              title="Settings"
            >
              <SettingsIcon />
            </button>
          </nav>
        </div>

        <div className="content-area">
          {/* ── Tab header ── */}
          <div className="content-header">
            <div
              className="content-header-spacer"
              style={{ width: sectionVisible ? sidebarWidth + 4 : 14 }}
            />

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
                      onMouseDown={paneResize.getOnMouseDown(
                        panes[idx - 1].id,
                        paneResize.sizes[panes[idx - 1].id] ?? 200,
                      )}
                    />
                  )}
                  <div
                    className={`pane-tabbar${pane.id === dropPaneId ? " pane-drop-target" : ""}`}
                    style={
                      pw !== undefined
                        ? { width: pw - cornerOffset, flexShrink: 0 }
                        : { flex: 1 }
                    }
                    onDragOver={e => {
                      e.preventDefault();
                      setDropPaneId(pane.id);
                    }}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node))
                        setDropPaneId(null);
                    }}
                    onDrop={() => {
                      setDropPaneId(null);
                      if (dragTabRef.current)
                        handleMoveTab(
                          dragTabRef.current.paneId,
                          dragTabRef.current.key,
                          pane.id,
                        );
                    }}
                  >
                    <div className="pane-tabs-scroll">
                      {pane.tabs.map(tab => {
                        const key = tabKey(tab);
                        const tabPrompt =
                          tab.type === "prompt"
                            ? prompts.find(
                                p =>
                                  p.id === tab.promptId &&
                                  p.providerId === tab.providerId,
                              )
                            : undefined;
                        const name =
                          tab.type === "prompt"
                            ? (tabPrompt?.name ?? tab.promptId)
                            : tab.type === "trace" || tab.type === "dataset"
                              ? tab.label
                              : tab.type === "terminal"
                                ? tab.label
                                : tab.type === "settings"
                                  ? settingsSectionLabel(tab.section)
                                  : "Welcome";
                        const icon =
                          tab.type === "trace" ? (
                            <TracesIcon />
                          ) : tab.type === "dataset" ? (
                            <DatasetsGlyph size={14} />
                          ) : tab.type === "welcome" ? (
                            <WelcomeIcon />
                          ) : tab.type === "terminal" ? (
                            <TerminalIcon />
                          ) : tab.type === "settings" ? (
                            <SettingsIcon />
                          ) : undefined;
                        return (
                          <Tab
                            key={key}
                            name={name}
                            icon={icon}
                            active={key === pane.activeTabKey}
                            // Unsaved edits live on the server, so they're
                            // dirty for as long as they exist, not just while
                            // a request is in flight.
                            dirty={dirtyTabs.has(key) || !!tabPrompt?.dirty}
                            onClick={() => {
                              setFocusedPaneId(pane.id);
                              setPanes(prev =>
                                prev.map(p =>
                                  p.id === pane.id
                                    ? { ...p, activeTabKey: key }
                                    : p,
                                ),
                              );
                            }}
                            onClose={e => handleCloseTab(pane.id, key, e)}
                            onDragStart={() => {
                              dragTabRef.current = { paneId: pane.id, key };
                            }}
                            onDragEnd={() => {
                              dragTabRef.current = null;
                            }}
                          />
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="tab-split-btn"
                      onClick={() => handleSplitPane(pane.id)}
                      title="Split pane"
                    >
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
                <aside
                  className="section-panel"
                  style={{ width: sidebarWidth }}
                >
                  {activeSection === "prompts" && (
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
                        const updated = await renamePrompt(
                          prompt,
                          newName,
                        ).catch(() => null);
                        if (updated) {
                          refetchPrompts();
                          handleSelectPrompt(
                            requireProviderId(
                              updated.providerId ?? prompt.providerId,
                              `selecting renamed prompt ${updated.id}`,
                            ),
                            updated.id,
                          );
                        }
                      }}
                    />
                  )}
                  {activeSection === "traces" && (
                    <TraceList
                      traces={traces}
                      loading={false}
                      error={null}
                      selectedTraceKey={selectedTraceKey}
                      onSelect={t =>
                        openTabInFocusedPane({
                          type: "trace",
                          providerId: t.providerId,
                          traceId: t.id,
                          rootSpanId: "",
                          label: t.name,
                        })
                      }
                      sidebarWidth={sidebarWidth}
                      onResizeSidebar={w => sidebar.setSize("w", w)}
                    />
                  )}
                  {activeSection === "datasets" && (
                    <DatasetList
                      datasets={datasets}
                      loading={datasetsLoading}
                      error={datasetsError}
                      selectedKey={selectedDatasetKey}
                      onSelect={d =>
                        openTabInFocusedPane({
                          type: "dataset",
                          providerId: d.providerId,
                          datasetId: d.id,
                          label: d.name,
                        })
                      }
                      promptName={ref => findPrompt(ref)?.name}
                      sidebarWidth={sidebarWidth}
                      onResizeSidebar={w => sidebar.setSize("w", w)}
                    />
                  )}
                  {activeSection === "settings" && (
                    <SettingsList
                      selectedSection={selectedSettingsSection}
                      onSelect={section =>
                        openTabInFocusedPane({ type: "settings", section })
                      }
                    />
                  )}
                </aside>
                <div
                  className="resize-handle"
                  onMouseDown={sidebar.getOnMouseDown("w", sidebarWidth)}
                />
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
                      onMouseDown={paneResize.getOnMouseDown(
                        panes[idx - 1].id,
                        paneResize.sizes[panes[idx - 1].id] ?? 200,
                      )}
                    />
                  )}
                  <main
                    className="main-content"
                    data-pane={pane.id}
                    style={
                      pw !== undefined
                        ? { width: pw, flexShrink: 0 }
                        : { flex: 1 }
                    }
                    onClick={() => setFocusedPaneId(pane.id)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => {
                      if (dragTabRef.current)
                        handleMoveTab(
                          dragTabRef.current.paneId,
                          dragTabRef.current.key,
                          pane.id,
                        );
                    }}
                  >
                    {pane.tabs.length === 0 && (
                      <div className="empty-state">
                        <img
                          src="/favicon.svg"
                          alt=""
                          style={{ width: 96, height: 96, opacity: 0.18 }}
                        />
                      </div>
                    )}
                    {pane.tabs.map(tab => {
                      const key = tabKey(tab);
                      const visible =
                        key === pane.activeTabKey
                          ? { display: "contents" }
                          : { display: "none" };
                      if (tab.type === "welcome") {
                        return (
                          <div key={key} style={visible}>
                            <WelcomeWizard
                              configured={configured}
                              onCreatePrompt={() => setShowAddPrompt(true)}
                              onOpenTerminal={(
                                taskId,
                                stepId,
                                command,
                                label,
                              ) =>
                                openTerminalRightOf(
                                  pane.id,
                                  taskId,
                                  stepId,
                                  command,
                                  label,
                                )
                              }
                            />
                          </div>
                        );
                      }
                      if (tab.type === "terminal") {
                        return (
                          <div key={key} style={visible}>
                            <TerminalView
                              taskId={tab.taskId}
                              stepId={tab.stepId}
                              command={tab.command}
                            />
                          </div>
                        );
                      }
                      if (tab.type === "settings") {
                        return (
                          <div key={key} style={visible}>
                            <SettingsView section={tab.section} />
                          </div>
                        );
                      }
                      if (tab.type === "prompt") {
                        const prompt =
                          prompts.find(
                            p =>
                              p.id === tab.promptId &&
                              p.providerId === tab.providerId,
                          ) ?? null;
                        if (!prompt) return null;
                        return (
                          <div key={key} style={visible}>
                            <PlaygroundContent
                              prompt={prompt}
                              promptRef={tab.ref}
                              onRefChange={ref => setPromptTabRef(key, ref)}
                              refreshKey={promptsVersion}
                              onRefresh={refetchPrompts}
                              onUpdate={patchPrompt}
                              onDirtyChange={dirty =>
                                handleDirtyChange(key, dirty)
                              }
                              onExecuted={result =>
                                openTraceTabRightOf(pane.id, result)
                              }
                              fill={tab.fill}
                              onOpenFillSource={from =>
                                openFillSource(pane.id, from)
                              }
                            />
                          </div>
                        );
                      }
                      if (tab.type === "dataset") {
                        return (
                          <div key={key} style={visible}>
                            <Suspense fallback={null}>
                              <DatasetView
                                providerId={tab.providerId}
                                datasetId={tab.datasetId}
                                version={datasetVersion}
                                findPrompt={findPrompt}
                                prompts={prompts}
                                onOpenPrompt={prompt =>
                                  openPromptTabRightOf(pane.id, prompt)
                                }
                                onOpenInPlayground={(prompt, fill) =>
                                  openPromptTabRightOf(pane.id, prompt, fill)
                                }
                                onOpenTrace={(providerId, traceId) =>
                                  openTabRightOf(
                                    pane.id,
                                    traceTab(providerId, traceId),
                                  )
                                }
                                onDeleted={() => closeTabEverywhere(key)}
                              />
                            </Suspense>
                          </div>
                        );
                      }
                      return (
                        <div key={key} style={visible}>
                          <TraceView
                            providerId={tab.providerId}
                            traceId={tab.traceId}
                            initialSpanId={tab.rootSpanId || undefined}
                            onOpenPrompt={prompt =>
                              openPromptFromTrace(
                                pane.id,
                                prompt,
                                tab.traceId,
                                tab.providerId,
                              )
                            }
                            findPrompt={findPrompt}
                            onDeleted={() => {
                              closeTabEverywhere(key);
                              refetchTraces();
                            }}
                          />
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
          onCreated={prompt => {
            setShowAddPrompt(false);
            refetchPrompts();
            handleSelectPrompt(
              requireProviderId(
                prompt.providerId,
                `selecting created prompt ${prompt.id}`,
              ),
              prompt.id,
            );
          }}
        />
      )}
    </div>
  );
}

export default App;
