// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { readFileSync } from "node:fs";
import path from "node:path";
import type { EvalutionConfig } from "../config.ts";
import { startServer } from "../server/index.ts";
import { TerminalSessionRegistry } from "../server/terminal.ts";
import { registerBundlerResolutionFallback } from "./bundler-resolution-hook.ts";
import {
  registerEvalutionResolver,
  registerPeerDependencyResolver,
} from "./config-loader-hooks.ts";
import { watchForConfigCreation } from "./config-watcher.ts";
import { findAvailablePort } from "./find-port.ts";
import {
  keepStdoutForProtocol,
  relayMcpToServer,
  serveMcpInProcess,
} from "./mcp.ts";
import { openBrowser } from "./open-browser.ts";
import { findRootDir, loadConfig, setUpProject } from "./project.ts";
import { findRunningServer, writeServerInfo } from "./server-discovery.ts";
import { registerVariationLoaderHook } from "./variation-loader-hook.ts";

/**
 * This package's version. `../../package.json` from both `src/cli/` and the
 * bundled `dist/cli/`.
 */
const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

// Make a project's config resolve `import ... from 'evalution'` against this
// CLI rather than the project's node_modules, so configs load even when
// evalution is run via `npx` with no local install. Registered once, up front,
// before any config import happens.
registerEvalutionResolver(import.meta.url);

// Served projects' prompt files (and whatever they import) are commonly
// authored for a bundler, which resolves extensionless and directory
// imports; Node's own loader, which runs them here, does not. Registered
// once, up front, before any prompt file is ever imported for execution.
registerBundlerResolutionFallback();

// Prompt variations run without their patched source touching disk: it is
// imported under the real file's URL plus `?evalution-src=<sha256>`, which
// this hook answers from memory. See `./variation-loader-hook.ts`.
registerVariationLoaderHook();

async function startConfiguredServer(
  rootDir: string,
  config: EvalutionConfig,
  hasConfig: boolean,
  port: number,
  terminalSessions: TerminalSessionRegistry,
) {
  return startServer({
    ...(await setUpProject(rootDir, config)),
    port,
    rootPath: rootDir,
    hasConfig,
    terminalSessions,
    version: VERSION,
  });
}

const USAGE = "Usage: evalution [ui [path]] | evalution mcp [path]";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "ui";

  // Accept: (no args) | "ui [path]" | "mcp [path]"
  if (command !== "ui" && command !== "mcp") {
    console.error(`Unknown command: ${args[0]}`);
    console.error(USAGE);
    process.exit(1);
  }
  // Before anything can print: over stdio, stdout is the protocol's.
  if (command === "mcp") keepStdoutForProtocol();

  const pathArg = args[1];
  const startDir = pathArg ? path.resolve(pathArg) : process.cwd();
  const { rootDir, hasConfig } = await findRootDir(startDir);

  // Let the lazily-imported optional peer deps (`ai`, `@google/genai`) fall
  // back to the served project's node_modules. Under `npx` they are absent
  // from the CLI's own install — npm never installs optional peer deps — so
  // without this the first `import('ai')` crashes the CLI at startup even
  // though the project has `ai` installed. Registered before any config or
  // prompt module is imported.
  registerPeerDependencyResolver(rootDir);

  if (command === "mcp") {
    await mcp(rootDir, hasConfig);
    return;
  }
  await ui(rootDir, hasConfig);
}

/**
 * `evalution mcp`: relay to the UI if it's serving this project — it holds
 * the project's databases — else serve in-process.
 */
async function mcp(rootDir: string, hasConfig: boolean) {
  const running = await findRunningServer(rootDir);
  if (running) {
    await relayMcpToServer(running);
    return;
  }
  // No onboarding here: with no config yet, the defaults serve (and a config
  // created later is picked up the next time the agent starts this).
  const config = hasConfig ? await loadConfig(rootDir) : {};
  if (!hasConfig) process.chdir(rootDir);
  await serveMcpInProcess(
    rootDir,
    await setUpProject(rootDir, config),
    VERSION,
  );
}

/** `evalution ui`: serve the playground, opening it in a browser. */
async function ui(rootDir: string, hasConfig: boolean) {
  // Resolve the port once, up front, so the onboarding restart binds the same
  // port the browser was opened on. An explicit `PORT` is honored strictly; a
  // busy default (3000) falls back to the next free port instead of crashing.
  let port: number;
  if (process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
  } else {
    port = await findAvailablePort(3000);
  }

  // Open the browser once the first server is listening. Subsequent restarts
  // (after a config file appears) reuse the same URL, so we don't reopen.
  // `EVALUTION_NO_OPEN` opts out (CI, remote/headless hosts).
  const maybeOpen = async (url: string) => {
    if (process.env.EVALUTION_NO_OPEN) return;
    await new Promise(r => setTimeout(r, 250));
    openBrowser(url);
  };

  // Lives across the onboarding restart below so a coding agent's PTY survives
  // being temporarily disconnected and the reconnecting client resumes it.
  const terminalSessions = new TerminalSessionRegistry();

  if (hasConfig) {
    const handle = await startConfiguredServer(
      rootDir,
      await loadConfig(rootDir),
      true,
      port,
      terminalSessions,
    );
    await writeServerInfo(rootDir, handle.url);
    await maybeOpen(handle.url);
    return;
  }

  // No config yet: start in onboarding mode with defaults so the UI (and its
  // `POST /api/config/create` route) is reachable, then watch for the config
  // file to appear and restart the server with the real config once it does.
  let server = await startConfiguredServer(
    rootDir,
    {},
    false,
    port,
    terminalSessions,
  );
  await writeServerInfo(rootDir, server.url);
  await maybeOpen(server.url);
  console.log(
    `👀 No config found; watching ${path.join(rootDir, ".evalution", "config.ts")} for creation...`,
  );

  const stopWatching = watchForConfigCreation(rootDir, async () => {
    // Load before tearing anything down: if the config is broken (e.g. a bad
    // import), this throws, the watcher logs it, and the onboarding server
    // stays up so the user can fix the file and have it retried.
    const config = await loadConfig(rootDir);
    console.log("⚙️ Config loaded; restarting server...");
    stopWatching();
    await server.close();
    server = await startConfiguredServer(
      rootDir,
      config,
      true,
      port,
      terminalSessions,
    );
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
