// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { createPersistentValue } from "./persistent-value";

/** The user's appearance choice, set in the Appearance settings section. */
export type ThemeSetting = "light" | "dark" | "system";

/** Recovers a theme setting from `localStorage`, tolerating anything else. */
export function parseThemeSetting(raw: string): ThemeSetting {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export const themeSetting = createPersistentValue<ThemeSetting>(
  "evalution.theme",
  "system",
  parseThemeSetting,
);

/** The concrete theme a setting resolves to, given the OS's current preference. */
export function resolveTheme(
  setting: ThemeSetting,
  systemPrefersDark: boolean,
): "light" | "dark" {
  return setting === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : setting;
}

const media =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

// Every stylesheet dark-mode rule is gated on this attribute rather than on
// `prefers-color-scheme` directly, so "system" is the only place the OS
// preference is read — an explicit light/dark choice always wins.
const appliedListeners = new Set<() => void>();

function apply() {
  document.documentElement.dataset.theme = resolveTheme(
    themeSetting.get(),
    !!media?.matches,
  );
  for (const listener of appliedListeners) listener();
}

if (typeof document !== "undefined") {
  apply();
  themeSetting.subscribe(apply);
  media?.addEventListener("change", () => {
    if (themeSetting.get() === "system") apply();
  });
}

/**
 * Fires whenever the resolved (not just the chosen) theme changes — for
 * surfaces that copy CSS colors once, like a canvas, and so can't simply
 * react to a stylesheet swap on their own.
 */
export function subscribeAppliedTheme(listener: () => void): () => void {
  appliedListeners.add(listener);
  return () => appliedListeners.delete(listener);
}
