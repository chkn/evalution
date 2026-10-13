// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useState } from "react";
import type { ViewTheme } from "../../../views/protocol.ts";
import { subscribeAppliedTheme } from "../../theme.ts";

/**
 * The theme tokens a view's frame is given, by the host custom property each
 * is read from — a small, framework-neutral vocabulary rather than the
 * host's own names, which are free to change.
 */
const FROM_HOST: Record<string, string> = {
  "--ev-bg": "--content-bg",
  "--ev-bg-subtle": "--panel-bg",
  "--ev-fg": "--panel-text",
  "--ev-fg-muted": "--panel-text-secondary",
  "--ev-fg-faint": "--panel-text-muted",
  "--ev-border": "--panel-border",
  "--ev-accent": "--accent",
  "--ev-on-accent": "--on-accent",
  "--ev-link": "--link",
  "--ev-hover": "--tree-hover",
  "--ev-selected": "--tree-selected-bg",
  "--ev-input-bg": "--input-bg",
  "--ev-input-border": "--input-border",
  "--ev-removed": "--error-text",
  "--ev-removed-bg": "--error-bg",
};

/** Tokens the host has no property for, by mode. */
const FIXED: Record<ViewTheme["mode"], Record<string, string>> = {
  light: {
    "--ev-added": "#1a7f37",
    "--ev-added-bg": "rgba(46, 160, 67, 0.14)",
    "--ev-changed": "#9a6700",
    "--ev-changed-bg": "rgba(212, 167, 44, 0.16)",
  },
  dark: {
    "--ev-added": "#56d364",
    "--ev-added-bg": "rgba(46, 160, 67, 0.22)",
    "--ev-changed": "#e3b341",
    "--ev-changed-bg": "rgba(187, 128, 9, 0.22)",
  },
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The host's current theme, as a view's frame is given it. */
export function currentViewTheme(): ViewTheme {
  const root = document.documentElement;
  const mode = root.dataset.theme === "dark" ? "dark" : "light";
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = { ...FIXED[mode] };
  for (const [token, host] of Object.entries(FROM_HOST)) {
    const value = computed.getPropertyValue(host).trim();
    if (value) tokens[token] = value;
  }
  tokens["--ev-font"] = getComputedStyle(document.body).fontFamily;
  tokens["--ev-mono"] = MONO;
  return { mode, tokens };
}

/** {@link currentViewTheme}, kept current as the theme changes. */
export function useViewTheme(): ViewTheme {
  const [theme, setTheme] = useState(currentViewTheme);
  useEffect(
    () => subscribeAppliedTheme(() => setTheme(currentViewTheme())),
    [],
  );
  return theme;
}
