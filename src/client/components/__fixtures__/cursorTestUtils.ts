// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Locator } from "@playwright/test";

/**
 * Returns the absolute character offset of the cursor within a contentEditable
 * element, counting through text nodes and token spans. Returns null if the
 * element does not contain the selection.
 */
export async function getCursorOffset(
  locator: Locator,
): Promise<number | null> {
  return locator.evaluate((el: HTMLElement) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;

    let offset = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
    let node = walker.nextNode();

    while (node) {
      if (node === range.startContainer) {
        return (
          offset + (node.nodeType === Node.TEXT_NODE ? range.startOffset : 0)
        );
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += node.textContent?.length ?? 0;
      } else if (node instanceof HTMLElement && node.tagName === "BR") {
        offset += 1;
      }
      node = walker.nextNode();
    }

    return offset;
  });
}
