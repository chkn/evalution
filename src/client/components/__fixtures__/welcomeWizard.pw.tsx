import { test, expect } from '@playwright/experimental-ct-react';
import { WelcomeWizardHarness } from './WelcomeWizardHarness';

test('skipping the login step advances to manual setup', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);

  // First step is the stubbed Evalution Cloud login.
  await expect(component.getByRole('heading', { name: /Log in to Evalution Cloud/ })).toBeVisible();

  await component.getByRole('button', { name: /Skip for now/ }).click();

  // Second step shows both the agent and manual setup paths.
  await expect(component.getByRole('heading', { name: /Set up with a coding agent/ })).toBeVisible();
  await expect(component.getByRole('heading', { name: /Manual setup/ })).toBeVisible();
});

test('changing the AI SDK updates the config snippet', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);
  await component.getByRole('button', { name: /Skip for now/ }).click();

  const snippet = component.locator('.copy-box-multiline pre');
  await expect(snippet).toContainText('VercelAISDK');

  await component.getByRole('combobox').selectOption('other');
  await expect(snippet).not.toContainText('VercelAISDK');
  await expect(snippet).toContainText('YourSDKAdapter');
});

test('Create New Prompt invokes the callback', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);
  await component.getByRole('button', { name: /Skip for now/ }).click();

  await expect(component.getByTestId('create-prompt-calls')).toHaveText('0');
  await component.getByRole('button', { name: 'Create New Prompt' }).click();
  await expect(component.getByTestId('create-prompt-calls')).toHaveText('1');
});

test('a completed returnable step is a link back in the progress header', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);
  await component.getByRole('button', { name: /Skip for now/ }).click();
  await expect(component.getByRole('heading', { name: /Manual setup/ })).toBeVisible();

  // The login step opted into canReturn, so it renders as a clickable progress step.
  await component.getByRole('button', { name: /Sign in/ }).click();
  await expect(component.getByRole('heading', { name: /Log in to Evalution Cloud/ })).toBeVisible();
});

test('sign-up and forgot-login open external pages in a new tab', async ({ mount }) => {
  const component = await mount(<WelcomeWizardHarness />);

  const signup = component.getByRole('link', { name: /Need an account\? Sign up/ });
  await expect(signup).toHaveAttribute('href', 'https://evalut.io/signup');
  await expect(signup).toHaveAttribute('target', '_blank');

  const forgot = component.getByRole('link', { name: /Forgot your login\?/ });
  await expect(forgot).toHaveAttribute('href', 'https://evalut.io/forgot');
  await expect(forgot).toHaveAttribute('target', '_blank');
});
