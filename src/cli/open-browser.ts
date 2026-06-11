// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { spawn } from "node:child_process";

/**
 * Returns the platform-specific command and args used to open `url` in the
 * user's default browser. Exposed separately from {@link openBrowser} so the
 * mapping can be unit-tested without spawning a process.
 *
 * @param url - The URL to open.
 * @param platform - A `process.platform` value; defaults to the current platform.
 */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `start` is a cmd builtin; the empty "" is the window title it expects
      // as its first quoted argument.
      return { command: "cmd", args: ["/c", "start", '""', url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/**
 * Opens `url` in the user's default browser, detached so it never blocks or
 * keeps the CLI alive. Failures (e.g. no browser, headless host) are swallowed
 * — opening the browser is a convenience, not a requirement, and the URL is
 * always printed to the console as a fallback.
 *
 * @param url - The URL to open.
 */
export function openBrowser(url: string): void {
  try {
    const { command, args } = browserOpenCommand(url);
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore — the URL has already been logged for the user to open manually.
  }
}
