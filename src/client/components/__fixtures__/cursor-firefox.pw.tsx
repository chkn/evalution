// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { test, expect } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { CursorHarness } from './CursorHarness';

// Firefox-specific: clicking past a trailing contenteditable=false token
// doesn't place the cursor after it by default, so typing at the end gets
// dropped. Chromium/WebKit don't exhibit this, so the test is scoped here.
test.use({ browserName: 'firefox' });

async function mockApiRoutes(page: Page) {
  await page.route('**/models', route => route.fulfill({ json: { models: [] } }));
  await page.route('**/model-parameters', route => route.fulfill({ json: [] }));
  await page.route('**/update', async route => {
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

test('can type at the end when content ends in an interpolated token', async ({ mount, page }) => {
  await mockApiRoutes(page);

  const component = await mount(<CursorHarness initialContent="Hello ${name}" />);
  const editor = component.locator('.token-editor').nth(1);

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  await expect(editor).toHaveText('Hello ${name}!');
});
