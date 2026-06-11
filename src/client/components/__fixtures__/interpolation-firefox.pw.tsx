// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { test, expect } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { InterpolationHarness } from './InterpolationHarness';

// Firefox-specific: completing a `${…}` via the autocomplete then typing the
// closing brace must still turn it into a token. (Chromium passes; Firefox's
// execCommand/selection handling exposed a regression.)
test.use({ browserName: 'firefox' });

async function mockApiRoutes(page: Page) {
  await page.route('**/models', route => route.fulfill({ json: { models: [] } }));
  await page.route('**/model-parameters', route => route.fulfill({ json: [] }));
  await page.route('**/update', async route => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      json: {
        id: 'test',
        name: 'test',
        functionParameters: [],
        modelEditable: true,
        system: body.system ?? { kind: 'primitive', value: '' },
        systemEditable: true,
        messages: Array.isArray(body.messages) ? body.messages : [],
        messagesEditable: true,
        modelParameters: [],
      },
    });
  });
}

test('Enter accepts a suggestion and closes it into a token (firefox)', async ({ mount, page }) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator('.token-editor').nth(1);

  await editor.click();
  await page.keyboard.type('${');
  await page.keyboard.press('Enter'); // accept "name" + close

  await expect(editor.locator('.te-token')).toHaveText('${name}');
});

test('typing } commits even after dismissing the dropdown (firefox)', async ({ mount, page }) => {
  await mockApiRoutes(page);
  const component = await mount(<InterpolationHarness />);
  const editor = component.locator('.token-editor').nth(1);

  await editor.click();
  await page.keyboard.type('${');
  await page.keyboard.press('Tab');    // accept "name", stay open
  await page.keyboard.press('Escape'); // dismiss popup
  await page.keyboard.type('}');

  await expect(editor.locator('.te-token')).toHaveText('${name}');
});
