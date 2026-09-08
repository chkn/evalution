// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Gap kept between the popover and the viewport's edge when clamping it back on screen. */
const VIEWPORT_MARGIN = 8;

/** What {@link useAnchoredPopover} accepts. */
export interface AnchoredPopoverOptions {
  /** Whether the popover is currently open. */
  open: boolean;
  /** Called to close the popover — an outside click or `Escape` fires this. */
  onClose: () => void;
  /**
   * Whether the popover's width is pinned to the trigger's own width, the
   * way a `<select>`-replacement dropdown wants. Defaults to `true`; a menu
   * that sizes itself to its content (a nested source picker, say) passes
   * `false`.
   */
  matchTriggerWidth?: boolean;
  /**
   * A click is also treated as "inside" — not closing the popover — when
   * this returns `true` for its target. For a popover that spawns further
   * portals of its own (a flyout submenu, say) that aren't DOM descendants
   * of `popoverRef` even though they're logically part of it: without this,
   * a click inside one is seen as an outside click and closes everything on
   * `mousedown`, before the click that would have chosen something even
   * fires.
   */
  extraContains?: (target: Node) => boolean;
}

/**
 * Positions a portal-rendered popover against a trigger element, and closes
 * it on an outside click, `Escape`, or the trigger scrolling out from under
 * it.
 *
 * Extracted from `ModelPicker`, which was the first component to need this —
 * fixed positioning off `getBoundingClientRect`, outside-`mousedown` and
 * `Escape` to close, reposition on capture-phase scroll and resize. A nested
 * flyout submenu (`SourcePicker`) has its own, different anchoring (against
 * a hovered row rather than a single trigger, with edge-flipping) and does
 * not use this hook.
 *
 * @typeParam T - The trigger element's type.
 */
export function useAnchoredPopover<T extends HTMLElement = HTMLElement>({
  open,
  onClose,
  matchTriggerWidth = true,
  extraContains,
}: AnchoredPopoverOptions): {
  triggerRef: React.RefObject<T | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
} {
  const triggerRef = useRef<T>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;

    if (matchTriggerWidth) {
      setStyle({
        position: "fixed",
        top,
        left,
        width: rect.width,
        zIndex: 9999,
      });
      return;
    }

    // A content-sized popover (no `width` pinned to the trigger) can overflow
    // the viewport when the trigger sits near an edge — the trigger itself is
    // on screen by definition, but the popover's own size isn't known until
    // it has rendered at least once. Clamp against its actual measured box
    // rather than guessing a width, flipping above/left of the trigger only
    // when there isn't room below/right of it either.
    const box = popoverRef.current?.getBoundingClientRect();
    if (box) {
      if (left + box.width > window.innerWidth - VIEWPORT_MARGIN) {
        left = Math.max(VIEWPORT_MARGIN, rect.right - box.width);
      }
      left = Math.min(left, window.innerWidth - VIEWPORT_MARGIN - box.width);
      left = Math.max(VIEWPORT_MARGIN, left);

      if (top + box.height > window.innerHeight - VIEWPORT_MARGIN) {
        const above = rect.top - 4 - box.height;
        top = above >= VIEWPORT_MARGIN ? above : VIEWPORT_MARGIN;
      }
    }

    setStyle({ position: "fixed", top, left, zIndex: 9999 });
  }, [matchTriggerWidth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `onClose` and `extraContains` are expected to be referentially stable (or wrapped by the caller) — re-running this effect on every render would drop and re-attach the listeners for no reason.
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      if (extraContains?.(target)) return;
      onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  return { triggerRef, popoverRef, style };
}
