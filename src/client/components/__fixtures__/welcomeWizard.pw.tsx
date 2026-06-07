import { test, expect } from '@playwright/experimental-ct-react';
import { WelcomeWizardHarness } from './WelcomeWizardHarness';

test('starts on the setup step with no next/create-prompt action', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);

  // The setup step shows both the agent and manual setup paths.
  await expect(component.getByRole('heading', { name: /Set up with a coding agent/ })).toBeVisible();
  await expect(component.getByRole('heading', { name: /Manual setup/ })).toBeVisible();

  // It advances on its own once a config loads, so it offers no manual progression.
  await expect(component.getByRole('button', { name: 'Create New Prompt' })).toHaveCount(0);
  await expect(component.getByRole('button', { name: /Next/ })).toHaveCount(0);
});

test('manual setup shows the Vercel SDK snippet and links other SDKs externally', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);

  const snippet = component.locator('.copy-box-multiline pre');
  await expect(snippet).toContainText('VercelAISDK');

  await expect(component.getByRole('button', { name: /Vercel AI SDK/ })).toHaveAttribute('aria-pressed', 'true');
  const other = component.getByRole('link', { name: 'Other' });
  await expect(other).toHaveAttribute('target', '_blank');
});

test('advances to the all-set step once a config is loaded', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);

  await expect(component.getByRole('heading', { name: /Manual setup/ })).toBeVisible();

  // Simulate the server picking up a freshly created config.
  await component.getByTestId('load-config').click();

  await expect(component.getByRole('heading', { name: /You're all set/ })).toBeVisible();
  await expect(component.getByRole('heading', { name: /Manual setup/ })).toHaveCount(0);
});

test('starts directly on the all-set step when already configured', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  await expect(component.getByRole('heading', { name: /You're all set/ })).toBeVisible();
  await expect(component.getByRole('heading', { name: /Manual setup/ })).toHaveCount(0);
});

test('all-set step links to the docs in a new tab', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  const docs = component.getByRole('link', { name: /Read the docs/ });
  await expect(docs).toHaveAttribute('href', 'https://evalut.io/docs/getting-started');
  await expect(docs).toHaveAttribute('target', '_blank');
});

test('Create New Prompt invokes the callback', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness initialConfigured />);

  await expect(component.getByTestId('create-prompt-calls')).toHaveText('0');
  await component.getByRole('button', { name: 'Create New Prompt' }).click();
  await expect(component.getByTestId('create-prompt-calls')).toHaveText('1');
});
