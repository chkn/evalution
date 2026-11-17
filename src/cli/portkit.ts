// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/** How long `portkit adopt` gets before startup carries on without it. */
const ADOPT_TIMEOUT_MS = 3000;

/** Runs a program and resolves to its stdout. */
export type RunCommand = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

const runCommand: RunCommand = promisify(execFile);

/** What portkit routes to an adopted server. */
export interface PortkitAdoption {
  /** Where portkit serves it. */
  url: string;
  /** How portkit runs it: `adopted`, or `port`, `on_demand` or `foreground`. */
  mode?: string;
}

/**
 * The portkit name for a project: `<dir>.evalution`, or just `evalution` when
 * nothing of the directory's name is usable in a DNS label.
 */
export function portkitServiceName(rootDir: string): string {
  const label = path
    .basename(rootDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
  return label ? `${label}.evalution` : "evalution";
}

/**
 * Names this server to portkit and labels it, so an app's SDK can find it and
 * it has an HTTPS URL for as long as this process lives. Portkit merges this
 * into the record when it already routes to `port`, as it does for a server
 * it started itself.
 *
 * Resolves to `undefined` if portkit isn't installed or refuses: nothing
 * depends on it.
 */
export async function adoptIntoPortkit(
  rootDir: string,
  port: number,
  {
    env = process.env,
    run = runCommand,
  }: { env?: NodeJS.ProcessEnv; run?: RunCommand } = {},
): Promise<PortkitAdoption | undefined> {
  const args = [
    "adopt",
    portkitServiceName(rootDir),
    String(port),
    "--label",
    "kind=evalution",
    "--json",
  ];
  // Portkit puts `PORTKIT_HOME` in the environment of what it starts, whose
  // `PATH` may not include its wrapper script.
  const [file, ...fullArgs] = env.PORTKIT_HOME
    ? [path.join(env.PORTKIT_HOME, "bin", "caddy"), "portkit", ...args]
    : ["portkit", ...args];
  try {
    const { stdout } = await run(file, fullArgs, {
      cwd: rootDir,
      timeout: ADOPT_TIMEOUT_MS,
    });
    const { url, record } = JSON.parse(stdout);
    return typeof url === "string" ? { url, mode: record?.mode } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether portkit started this process because a browser asked for it, so
 * the page it's holding is about to load and opening another would be a
 * second tab.
 */
export function startedOnDemand(
  adoption: PortkitAdoption | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env.PORTKIT_URL && adoption?.mode === "on_demand";
}

/**
 * Registers the server with portkit if it's there, and resolves to where a
 * proxy serves it: the one that started this process, or else the one that
 * just adopted it. `undefined` when no proxy does.
 *
 * When portkit started this process, call it only once the server is
 * listening: until then portkit refuses to merge into its own record, and the
 * mode is lost. {@link preparePortkit} sees to that.
 */
export async function resolvePublicUrl(
  rootDir: string,
  port: number,
  options: { env?: NodeJS.ProcessEnv; run?: RunCommand } = {},
): Promise<PortkitAdoption | undefined> {
  const { env = process.env } = options;
  const adoption = await adoptIntoPortkit(rootDir, port, options);
  const url = env.PORTKIT_URL ?? env.PORTLESS_URL ?? adoption?.url;
  // Adopting merges into the record portkit started us from, so its mode is
  // that record's too.
  return url ? { url, mode: adoption?.mode } : undefined;
}

/**
 * How long a server portkit started keeps asking it to merge the adoption:
 * portkit notices the server listening a moment after it does.
 */
const MERGE_RETRY_MS = 3000;
const MERGE_RETRY_INTERVAL_MS = 200;

/** Where a proxy serves the server, from {@link preparePortkit}. */
export interface PortkitPlan {
  /** Where a proxy serves it, known before it listens. */
  publicUrl: string | undefined;
  /**
   * Registers it with portkit, if that hasn't happened yet, and resolves to
   * where portkit serves it and how. Call it once the server is listening;
   * later calls resolve to the same.
   */
  adoption(): Promise<PortkitAdoption | undefined>;
}

/**
 * Works out where a proxy will serve the server about to start on `port`.
 *
 * A proxy that started this process already said where in its environment,
 * so registering waits for {@link PortkitPlan.adoption}: portkit merges into
 * the record it started this process from only once it has seen the server
 * listening, so a refusal is retried for a moment. Otherwise portkit is asked
 * now, as only it knows the URL.
 */
export async function preparePortkit(
  rootDir: string,
  port: number,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: RunCommand;
    /** Waits between attempts; a test's resolves at once. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<PortkitPlan> {
  const {
    env = process.env,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
  } = options;
  const proxied = env.PORTKIT_URL ?? env.PORTLESS_URL;
  if (!proxied) {
    const adoption = await resolvePublicUrl(rootDir, port, options);
    return { publicUrl: adoption?.url, adoption: async () => adoption };
  }
  const adoptOnceSeen = async () => {
    // Only portkit sets this, so it's installed and a refusal is worth
    // retrying. Under another proxy, one attempt is all there is.
    const attempts = env.PORTKIT_URL
      ? MERGE_RETRY_MS / MERGE_RETRY_INTERVAL_MS
      : 1;
    for (let i = 1; ; i++) {
      const adoption = await adoptIntoPortkit(rootDir, port, options);
      if (adoption || i >= attempts) {
        return { url: proxied, mode: adoption?.mode };
      }
      await sleep(MERGE_RETRY_INTERVAL_MS);
    }
  };
  let adoption: Promise<PortkitAdoption | undefined> | undefined;
  return {
    publicUrl: proxied,
    adoption: () => {
      adoption ??= adoptOnceSeen();
      return adoption;
    },
  };
}
