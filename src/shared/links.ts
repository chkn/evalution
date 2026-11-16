// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Every link evalution points people at, as a short link on Evalution Cloud's
 * link host. The cloud redirects each one, so where it goes can change with a
 * cloud deploy instead of a release.
 *
 * Dependency-free: imported by both the browser client and the server.
 */

/** The host that redirects the links below, and that project URLs are on. */
export const LINK_HOST = "l.evalut.io";

/**
 * The name of every short link, `l.evalut.io/s/<name>`. Evalution Cloud
 * imports this type, so its table of targets has one for each name and no
 * others.
 */
export type ShortLinkName =
  /** The documentation's home. Only the README links to it. */
  | "docs"
  | "setup"
  | "setup.md"
  | "config"
  | "prompts"
  | "agent-request"
  | "sdk-request"
  | "keys"
  | "sign-up"
  | "forgot-login";

const link = (name: ShortLinkName) => `https://${LINK_HOST}/s/${name}`;

/** The manual setup guide. */
export const SETUP_DOCS_URL = link("setup");

/** The manual setup guide as Markdown, for a coding agent to follow. */
export const SETUP_DOCS_MARKDOWN_URL = link("setup.md");

/** The configuration documentation. */
export const CONFIG_DOCS_URL = link("config");

/** The guide to writing prompts, where onboarding leaves off. */
export const PROMPTS_DOCS_URL = link("prompts");

/** Where to ask for support for a coding agent we don't list. */
export const AGENT_REQUEST_URL = link("agent-request");

/** Where to ask for support for an AI SDK we don't list. */
export const SDK_REQUEST_URL = link("sdk-request");

/** Where to create a personal Evalution Cloud API key. */
export const API_KEYS_URL = link("keys");

/** Evalution Cloud sign-up. */
export const SIGN_UP_URL = link("sign-up");

/** Evalution Cloud account recovery. */
export const FORGOT_LOGIN_URL = link("forgot-login");
