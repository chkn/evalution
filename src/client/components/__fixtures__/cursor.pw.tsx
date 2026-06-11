// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { test, expect } from '@playwright/experimental-ct-react';
import type { Locator, Page } from '@playwright/test';
import { CursorHarness } from './CursorHarness';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the absolute character offset of the cursor within a contentEditable
 * element, counting through text nodes and token spans. Returns null if the
 * element does not contain the selection.
 */
async function getCursorOffset(locator: Locator): Promise<number | null> {
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
        return offset + (node.nodeType === Node.TEXT_NODE ? range.startOffset : 0);
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += node.textContent?.length ?? 0;
      } else if (node instanceof HTMLElement && node.tagName === 'BR') {
        offset += 1;
      }
      node = walker.nextNode();
    }
    return offset;
  });
}

async function mockApiRoutes(page: Page) {
  await page.route('**/models', route => route.fulfill({ json: { models: [] } }));
  await page.route('**/model-parameters', route => route.fulfill({ json: [] }));
  await page.route('**/update', async route => {
    // Echo back a valid NormalizedPrompt so onUpdate doesn't blow away state
    const body = JSON.parse(route.request().postData() ?? '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = body.system ?? undefined;
    await route.fulfill({
      json: {
        id: 'test',
        name: 'test',
        functionParameters: [],
        modelEditable: true,
        system,
        systemEditable: true,
        messages,
        messagesEditable: true,
        modelParameters: [],
      },
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// .nth(0) = system editor, .nth(1) = first message editor

test('cursor preserved when external prompt update extends message content', async ({ mount, page }) => {
  await mockApiRoutes(page);

  const component = await mount(
    <CursorHarness initialContent="hello" reloadContent="hello world" />
  );

  const editor = component.locator('.token-editor').nth(1);

  await editor.click();
  await page.keyboard.press('End');
  expect(await getCursorOffset(editor)).toBe(5);

  // Simulate SSE-triggered reload: new prompt object, same prefix plus extra text.
  await component.locator('[data-testid="reload"]').click();
  await page.waitForTimeout(50);

  // Cursor must stay at 5, not reset to 0.
  expect(await getCursorOffset(editor)).toBe(5);
});

test('cursor preserved when typing in message editor during save/reload cycle', async ({ mount, page }) => {
  await mockApiRoutes(page);

  const component = await mount(<CursorHarness />);
  // Message editor (debounced save — 600 ms)
  const editor = component.locator('.token-editor').nth(1);

  await editor.click();
  await page.keyboard.type('hello world');
  expect(await getCursorOffset(editor)).toBe(11);

  // Wait for debounce + onUpdate → setPrompt to complete.
  await page.waitForTimeout(800);

  expect(await getCursorOffset(editor)).toBe(11);
});

test('cursor preserved when typing in system editor (immediate save per keystroke)', async ({ mount, page }) => {
  await mockApiRoutes(page);

  const component = await mount(<CursorHarness />);
  // System editor (no debounce — saves on every keystroke)
  const editor = component.locator('.token-editor').nth(0);

  await editor.click();
  await page.keyboard.type('hello world');

  // After all keystrokes + concurrent saves settle, cursor must be at end.
  await page.waitForTimeout(200);
  expect(await getCursorOffset(editor)).toBe(11);
});

