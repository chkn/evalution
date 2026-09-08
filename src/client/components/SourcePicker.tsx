// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ResourceInfo } from "../../shared/types";
import {
  buildSourceTree,
  flattenSourceTree,
  type SourceNode,
} from "./source-tree";
import { useAnchoredPopover } from "./use-anchored-popover";

/** Below this many selectable entries, a filter box isn't worth the extra row (§E). */
const FILTER_THRESHOLD = 8;

const MENU_ITEM_SELECTOR = '[role="menuitem"]';

/**
 * A nested menu offering every resource (and declared value) that fits a
 * slot, replacing the native `<select>` `SourceRow` used to render — which
 * supports only one level of `<optgroup>` and no nesting at all, so
 * arbitrary resource groups need a real menu. See
 * `specs/resource-hierarchy.md` §E.
 *
 * The tree itself is built by {@link buildSourceTree}; this component is
 * purely presentation and interaction — the portal, the flyout submenus, the
 * filter box, and keyboard traversal. `onChoose` is threaded unchanged
 * through every level and every flyout, so any row at any depth closes the
 * whole picker the same way: by calling it.
 */
export default function SourcePicker({
  resources,
  matching,
  chosen,
  stale,
  editable,
  label,
  onChoose,
}: {
  /** Every source offered to the prompt, unfiltered — for the tree's group/value context. */
  resources: readonly ResourceInfo[];
  /** The sources that fit this slot. */
  matching: readonly ResourceInfo[];
  /** The currently chosen uri, if any. */
  chosen: string | undefined;
  /** A chosen uri whose resource is no longer available, kept visible and selected. */
  stale: string | undefined;
  /** Whether the slot has an editor to fall back to — decides the "Custom" row. */
  editable: boolean;
  /** The slot's own name, for the trigger's `aria-label`. */
  label: string;
  /** Called with the chosen uri, or `null` for "Custom" / no resource. */
  onChoose: (uri: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const close = () => {
    setOpen(false);
    setFilter("");
  };
  const choose = (uri: string | null) => {
    onChoose(uri);
    close();
  };

  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
      // Flyout submenus are separate portals, not DOM descendants of the
      // root popover — without this, a click inside one reads as an
      // outside click and closes everything on `mousedown`, before the
      // click that would have chosen something even fires.
      extraContains: target =>
        !!(target as Element).closest?.(".pg-source-menu-flyout"),
    });

  const tree = useMemo(
    () =>
      buildSourceTree(
        resources,
        matching.map(r => r.uri),
      ),
    [resources, matching],
  );
  const flat = useMemo(() => flattenSourceTree(tree), [tree]);
  const showFilter = flat.length >= FILTER_THRESHOLD;
  const filtered =
    showFilter && filter.trim()
      ? flat.filter(n =>
          n.breadcrumb.toLowerCase().includes(filter.trim().toLowerCase()),
        )
      : undefined;

  const headerKind = editable ? "custom" : !chosen ? "placeholder" : undefined;

  return (
    <div className="pg-source-picker">
      <button
        ref={triggerRef}
        type="button"
        className="pg-slot-source-wrap"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Source for ${label}`}
        title="Pick a resource"
        onClick={() => setOpen(o => !o)}
      >
        <span className="pg-slot-source-icon" aria-hidden="true">
          ⋯
        </span>
      </button>

      {open &&
        createPortal(
          <div ref={popoverRef} className="pg-source-menu-root" style={style}>
            {showFilter && (
              <input
                type="text"
                className="pg-source-menu-filter"
                placeholder="Filter…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                autoFocus
              />
            )}
            {filtered ? (
              <FlatMatches nodes={filtered} chosen={chosen} onChoose={choose} />
            ) : (
              <SourceMenu
                nodes={tree}
                chosen={chosen}
                headerKind={headerKind}
                stale={stale}
                onChoose={choose}
                depth={0}
                autoFocusFirst={!showFilter}
              />
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** The filtered, flat rendering: one row per match, each with its breadcrumb for context. */
function FlatMatches({
  nodes,
  chosen,
  onChoose,
}: {
  nodes: readonly SourceNode[];
  chosen: string | undefined;
  onChoose: (uri: string) => void;
}) {
  return (
    <div className="pg-source-menu" role="menu">
      {nodes.length === 0 && (
        <div className="pg-source-menu-empty">No matches</div>
      )}
      {nodes.map(n => (
        <button
          key={n.uri}
          type="button"
          role="menuitem"
          className={
            "pg-source-menu-item" + (n.uri === chosen ? " selected" : "")
          }
          title={n.breadcrumb}
          onClick={() => onChoose(n.uri!)}
        >
          <span className="pg-source-menu-check">
            {n.uri === chosen ? "✓" : ""}
          </span>
          <span className="pg-source-menu-label">{n.label}</span>
          <span className="pg-source-menu-breadcrumb">{n.breadcrumb}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One level of the nested menu: `nodes` plus, at the root, the header row
 * ("Custom" / "Pick a resource…") and the stale-uri entry.
 *
 * Keyboard: `↑`/`↓` move within this level (found by querying this level's
 * own DOM subtree — a flyout below it portals elsewhere, so it's never
 * picked up by accident); `←`/`Escape` leave this level via `onLeaveLevel`,
 * or close the whole picker at the root (`depth === 0`). `→`/`Enter` are
 * handled per-row: {@link SourceMenuRow} opens its own flyout or chooses.
 */
function SourceMenu({
  nodes,
  chosen,
  headerKind,
  stale,
  onChoose,
  depth,
  onLeaveLevel,
  autoFocusFirst,
}: {
  nodes: readonly SourceNode[];
  chosen: string | undefined;
  headerKind?: "custom" | "placeholder";
  stale?: string;
  onChoose: (uri: string | null) => void;
  depth: number;
  /** Closes this level and returns focus to the parent row that opened it. Absent at the root. */
  onLeaveLevel?: () => void;
  autoFocusFirst?: boolean;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the first row exactly once, when this level mounts (a flyout mounts only when it opens) — not on every re-render.
  useEffect(() => {
    if (!autoFocusFirst) return;
    containerRef.current
      ?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)
      ?.focus();
  }, []);

  const moveFocus = (delta: 1 | -1) => {
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = idx < 0 ? 0 : (idx + delta + items.length) % items.length;
    items[next]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // A flyout below this level is open and owns the keyboard until it
    // closes — this level's own rows aren't focused while that's true.
    if (openIndex !== null) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowLeft":
        if (depth > 0) {
          e.preventDefault();
          onLeaveLevel?.();
        }
        break;
      case "Escape":
        // At the root, `useAnchoredPopover`'s own document-level listener
        // already closes the whole picker — nothing to do here but let it
        // bubble. A nested level leaves just its own flyout instead.
        if (depth > 0) {
          e.preventDefault();
          e.stopPropagation();
          onLeaveLevel?.();
        }
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="pg-source-menu"
      role="menu"
      ref={containerRef}
      onKeyDown={handleKeyDown}
    >
      {headerKind === "custom" && (
        <MenuRow
          label="Custom"
          selected={!chosen}
          onClick={() => onChoose(null)}
        />
      )}
      {headerKind === "placeholder" && (
        <div className="pg-source-menu-placeholder">Pick a resource…</div>
      )}
      {nodes.length === 0 && !headerKind && !stale && (
        <div className="pg-source-menu-empty">No sources available</div>
      )}
      {nodes.map((node, i) => (
        <SourceMenuRow
          key={node.uri ?? `group-${i}-${node.label}`}
          node={node}
          chosen={chosen}
          open={openIndex === i}
          onOpen={() => setOpenIndex(i)}
          onClose={() => setOpenIndex(null)}
          onChoose={onChoose}
          depth={depth}
        />
      ))}
      {stale && (
        <MenuRow
          label={`${stale} (unavailable)`}
          selected
          muted
          onClick={() => onChoose(stale)}
        />
      )}
    </div>
  );
}

/** A plain, non-nested menu row — "Custom" and the stale-uri entry. */
function MenuRow({
  label,
  selected,
  muted,
  onClick,
}: {
  label: string;
  selected: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={
        "pg-source-menu-item" +
        (selected ? " selected" : "") +
        (muted ? " muted" : "")
      }
      onClick={onClick}
    >
      <span className="pg-source-menu-check">{selected ? "✓" : ""}</span>
      <span className="pg-source-menu-label">{label}</span>
    </button>
  );
}

/**
 * One row for a group/resource/value {@link SourceNode}. A row with children
 * opens a flyout submenu (hover, click, `Enter`, or `→`) instead of choosing
 * anything; a leaf chooses its `uri` on click or `Enter`.
 */
function SourceMenuRow({
  node,
  chosen,
  open,
  onOpen,
  onClose,
  onChoose,
  depth,
}: {
  node: SourceNode;
  chosen: string | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChoose: (uri: string | null) => void;
  depth: number;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const [flyoutStyle, setFlyoutStyle] = useState<React.CSSProperties>({});
  const hasChildren = !!node.children && node.children.length > 0;
  const selected = !!node.uri && node.uri === chosen;

  const openFlyout = () => {
    if (!hasChildren) return;
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) {
      // Flyouts nest arbitrarily deep, so overflow has to be checked — and
      // flipped — per level rather than assuming the first one ever will.
      const overflowsRight = rect.right + 220 > window.innerWidth;
      setFlyoutStyle({
        position: "fixed",
        top: rect.top,
        ...(overflowsRight
          ? { right: window.innerWidth - rect.left }
          : { left: rect.right }),
        zIndex: 10000 + depth,
      });
    }
    onOpen();
  };

  const handleClick = () => {
    if (hasChildren) openFlyout();
    else if (node.uri) onChoose(node.uri);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" && hasChildren) {
      e.preventDefault();
      openFlyout();
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      className="pg-source-menu-row-wrap"
      onMouseEnter={hasChildren ? openFlyout : undefined}
    >
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        className={"pg-source-menu-item" + (selected ? " selected" : "")}
        title={node.breadcrumb}
        aria-haspopup={hasChildren ? "menu" : undefined}
        aria-expanded={hasChildren ? open : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span className="pg-source-menu-check">{selected ? "✓" : ""}</span>
        <span className="pg-source-menu-label">{node.label}</span>
        {hasChildren && (
          <span className="pg-source-menu-caret" aria-hidden="true">
            ▸
          </span>
        )}
      </button>
      {hasChildren &&
        open &&
        createPortal(
          <div className="pg-source-menu-flyout" style={flyoutStyle}>
            <SourceMenu
              nodes={node.children!}
              chosen={chosen}
              onChoose={onChoose}
              depth={depth + 1}
              autoFocusFirst
              onLeaveLevel={() => {
                onClose();
                rowRef.current?.focus();
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
