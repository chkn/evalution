// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Stops a publish that isn't run by pnpm, from each package's `prepublishOnly`.
 *
 * `@evalution/sdk` dependencies are declared `workspace:*`, and only
 * `pnpm publish` rewrites that to the real version in the published manifest.
 * `npm publish` ships it as-is, and every `npm install` of the package then
 * fails with `EUNSUPPORTEDPROTOCOL` (this is what broke 2.0.1). The manifest
 * on disk says `workspace:*` either way, so the package manager running the
 * script is the only thing to check.
 */

const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  const agent = userAgent.split(" ")[0] || "an unknown package manager";
  console.error(
    [
      "",
      `✖ Refusing to publish with ${agent}. Use pnpm instead:`,
      "",
      "    pnpm publish        # this package",
      "    pnpm -r publish     # every package, from the repo root",
      "",
      "npm publish leaves `workspace:*` dependencies in the published",
      "package.json, which makes the package uninstallable with npm.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
