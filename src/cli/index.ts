// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import type { EvalutionConfig } from "../config.ts";
import { startServer } from "../server/index.ts";
import { TerminalSessionRegistry } from "../server/terminal.ts";
import { type CliArgs, parseCliArgs, USAGE } from "./args.ts";
import { registerBundlerResolutionFallback } from "./bundler-resolution-hook.ts";
import {
  type CloudInstance,
  connectInstance,
  instanceRegistration,
  linkedCloudClient,
} from "./cloud.ts";
import { registerEvalutionResolver } from "./config-loader-hooks.ts";
import { watchForConfigCreation } from "./config-watcher.ts";
import { findAvailablePort } from "./find-port.ts";
import { registerFreshImportHook } from "./fresh-import-hook.ts";
import { link } from "./link.ts";
import {
  findOrBecomeHolder,
  keepStdoutForProtocol,
  type McpHolder,
  relayMcpToServer,
  serveMcpHolder,
} from "./mcp.ts";
import { openBrowser } from "./open-browser.ts";
import {
  type PortkitAdoption,
  resolvePublicUrl,
  startedOnDemand,
} from "./portkit.ts";
import {
  applyDotenv,
  findRootDir,
  loadConfig,
  setUpProject,
} from "./project.ts";
import {
  claimServerInfo,
  findRunningServer,
  writeServerInfo,
} from "./server-discovery.ts";
import { registerTypeScriptTransformFallback } from "./typescript-transform-hook.ts";
import { registerVariationLoaderHook } from "./variation-loader-hook.ts";

/** This package's version. */
const VERSION: string = packageJson.version;

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

// Prompt files and playground modules are re-imported to pick up edits, and
// Node never evicts a module: this carries a fresh import's cache-buster down
// to everything it imports by path, so an edited dependency is reloaded too.
// See `./fresh-import-hook.ts`.
registerFreshImportHook();

// Prompt variations run without their patched source touching disk: it is
// imported under the real file's URL plus `?evalution-src=<sha256>`, which
// this hook answers from memory. See `./variation-loader-hook.ts`.
registerVariationLoaderHook();

// Node's loader only strips types, so a prompt file (or anything it imports)
// written for `tsc` — parameter properties, enums, namespaces — would fail to
// load. This compiles just those modules with the `typescript` package
// instead. Registered after the variation hook so it runs first (hooks run
// last-registered first) and sees variations' in-memory sources too.
registerTypeScriptTransformFallback();

/** What `evalution ui` hands every server it starts. */
interface UiServerOptions {
  port: number;
  host: string | undefined;
  publicUrl: string | undefined;
  terminalSessions: TerminalSessionRegistry;
  /** This process's registration with Evalution Cloud, once it has one. */
  cloud: () => CloudInstance | undefined;
}

async function startConfiguredServer(
  rootDir: string,
  config: EvalutionConfig,
  hasConfig: boolean,
  { port, host, publicUrl, terminalSessions, cloud }: UiServerOptions,
) {
  return startServer({
    ...(await setUpProject(rootDir, config)),
    port,
    hostname: host,
    publicUrl,
    rootPath: rootDir,
    hasConfig,
    terminalSessions,
    version: VERSION,
    getProjectUrl: () => cloud()?.projectUrl,
    beforeExit: async () => {
      await cloud()?.stop();
    },
  });
}

/** How long opening the browser waits on the cloud, so "Copy link" is there from the start. */
const CLOUD_WAIT_MS = 2000;

/**
 * Registers the running playground with Evalution Cloud when the project is
 * linked and there's a personal key, resolving once the first attempt has
 * settled or {@link CLOUD_WAIT_MS} has passed.
 */
async function connectToCloud(
  rootDir: string,
  config: EvalutionConfig,
  localUrl: string,
  portkit: PortkitAdoption | undefined,
): Promise<CloudInstance | undefined> {
  const client = linkedCloudClient(config);
  const project = config.cloud?.project;
  if (!client || !project) return undefined;
  const registration = instanceRegistration({ rootDir, localUrl, portkit });
  if (!registration) {
    console.log(
      `💡 Not registering with Evalution Cloud: the project URL can only send a browser to this machine's loopback address, and the playground is at ${localUrl}.`,
    );
    return undefined;
  }
  const instance = connectInstance(client, registration, { project });
  await Promise.race([
    instance.ready,
    new Promise(resolve => setTimeout(resolve, CLOUD_WAIT_MS).unref()),
  ]);
  return instance;
}

async function main() {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    process.exit(1);
  }
  const { command, path: pathArg, host } = args;
  // Before anything can print: over stdio, stdout is the protocol's.
  if (command === "mcp") keepStdoutForProtocol();

  const startDir = pathArg ? path.resolve(pathArg) : process.cwd();
  const { rootDir, hasConfig } = await findRootDir(startDir);

  // Prompt and config modules resolve relative paths against the project.
  process.chdir(rootDir);

  if (command === "mcp") {
    await mcp(rootDir, hasConfig);
    return;
  }
  if (command === "link") {
    // For EVALUTION_API_KEY. The config isn't loaded, so `useDotenv` can't
    // be read; it's only the key that's wanted.
    applyDotenv(rootDir);
    process.exit(await link(rootDir, hasConfig));
  }
  await ui(rootDir, hasConfig, host);
}

/**
 * `evalution mcp`: relay stdio to whichever process is serving this project
 * — it holds the project's databases — becoming that process when there's
 * none, now or whenever the one relayed to goes away.
 */
async function mcp(rootDir: string, hasConfig: boolean) {
  let holder: McpHolder | undefined;
  const become = async () => {
    // No onboarding here: with no config yet, the defaults serve (and a
    // config created later is picked up the next time the agent starts this).
    const config = hasConfig ? await loadConfig(rootDir) : {};
    holder = await serveMcpHolder(
      rootDir,
      await setUpProject(rootDir, config),
      VERSION,
      hasConfig,
    );
    return holder.url;
  };
  const holderUrl = () =>
    holder ? Promise.resolve(holder.url) : findOrBecomeHolder(rootDir, become);
  await relayMcpToServer(await holderUrl(), {
    reconnect: holderUrl,
    // Eval runs started here, by any agent, run in this process: let them
    // finish before the other relays move on to a new holder.
    beforeExit: async () => {
      await holder?.idle();
    },
  });
}

/** `evalution ui`: serve the playground, opening it in a browser. */
async function ui(
  rootDir: string,
  hasConfig: boolean,
  host: string | undefined,
  attempt = 0,
) {
  // Another process already holds the project's databases, so this one
  // couldn't open them.
  const running = await findRunningServer(rootDir);
  if (!running && !(await claimServerInfo(rootDir, "ui"))) {
    // Another process claimed the project just now: go with it.
    if (attempt < 3) return ui(rootDir, hasConfig, host, attempt + 1);
    console.error(
      "Another evalution process has claimed this project but isn't serving it. Stop it, then run `evalution ui` again.",
    );
    process.exit(1);
  }
  if (running?.kind === "ui") {
    console.log(`✨ Evalution is already running at ${running.url}`);
    if (!process.env.EVALUTION_NO_OPEN) openBrowser(running.url);
    return;
  }
  if (running) {
    console.error(
      `An agent's \`evalution mcp\` (process ${running.pid}) is serving this project, and its databases can only be open in one process at a time. ` +
        "End that agent session (or stop the process), then run `evalution ui` again. Starting the playground before your agent avoids this: the agent's MCP server then connects to the playground.",
    );
    process.exit(1);
  }

  // Resolve the port once, up front, so the onboarding restart binds the same
  // port the browser was opened on. An explicit `PORT` is honored strictly; a
  // busy default (3000) falls back to the next free port instead of crashing.
  let port: number;
  if (process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
  } else {
    port = await findAvailablePort(3000, host);
  }

  // Behind a local HTTPS proxy, the playground is opened through it.
  const portkit = await resolvePublicUrl(rootDir, port);
  const publicUrl = portkit?.url;

  // Open the browser once the first server is listening. Subsequent restarts
  // (after a config file appears) reuse the same URL, so we don't reopen.
  // `EVALUTION_NO_OPEN` opts out (CI, remote/headless hosts). Portkit
  // starting this for a visit means a browser is already waiting on it.
  const maybeOpen = async (url: string) => {
    if (process.env.EVALUTION_NO_OPEN || startedOnDemand(portkit)) return;
    await new Promise(r => setTimeout(r, 250));
    openBrowser(url);
  };

  // Lives across the onboarding restart below so a coding agent's PTY survives
  // being temporarily disconnected and the reconnecting client resumes it.
  const terminalSessions = new TerminalSessionRegistry();

  let cloud: CloudInstance | undefined;
  const serverOptions: UiServerOptions = {
    port,
    host,
    publicUrl,
    terminalSessions,
    cloud: () => cloud,
  };

  if (hasConfig) {
    const config = await loadConfig(rootDir);
    const handle = await startConfiguredServer(
      rootDir,
      config,
      true,
      serverOptions,
    );
    await writeServerInfo(rootDir, handle.url, "ui");
    cloud = await connectToCloud(rootDir, config, handle.url, portkit);
    // Through the cloud when it answered in time, so this browser is
    // remembered as the one on this machine; it lands on the same page.
    await maybeOpen(cloud?.openUrl ?? handle.publicUrl);
    return;
  }

  // No config yet: start in onboarding mode with defaults so the UI (and its
  // `POST /api/config/create` route) is reachable, then watch for the config
  // file to appear and restart the server with the real config once it does.
  let server = await startConfiguredServer(rootDir, {}, false, serverOptions);
  await writeServerInfo(rootDir, server.url, "ui");
  await maybeOpen(server.publicUrl);
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
    server = await startConfiguredServer(rootDir, config, true, serverOptions);
    cloud = await connectToCloud(rootDir, config, server.url, portkit);
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
