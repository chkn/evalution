import { test, expect } from '@playwright/experimental-ct-react';
import { PlaygroundContentHarness } from './PlaygroundContentHarness';

test('narrow pane stays single-column at full width', async ({ mount }) => {
  const component = await mount(
    <PlaygroundContentHarness width={400} height={300} messagesCount={1} />
  );
  const pg = component.locator('.pg-content');
  await expect(pg).not.toHaveClass(/pg-content--multicol/);
  const paneWidth = await component.evaluate(el => el.getBoundingClientRect().width);
  const contentWidth = await pg.evaluate(el => el.getBoundingClientRect().width);
  expect(contentWidth).toBe(paneWidth);
});

test('wide pane with overflowing content switches to multi-column', async ({ mount }) => {
  const component = await mount(
    <PlaygroundContentHarness width={900} height={200} messagesCount={12} />
  );
  const pg = component.locator('.pg-content');
  await expect(pg).toHaveClass(/pg-content--multicol/);
});

test('wide pane with short content stays single-column at full width', async ({ mount }) => {
  const component = await mount(
    <PlaygroundContentHarness width={900} height={1200} messagesCount={1} />
  );
  const pg = component.locator('.pg-content');
  await expect(pg).not.toHaveClass(/pg-content--multicol/);
  const paneWidth = await component.evaluate(el => el.getBoundingClientRect().width);
  const contentWidth = await pg.evaluate(el => el.getBoundingClientRect().width);
  expect(contentWidth).toBe(paneWidth);
});
