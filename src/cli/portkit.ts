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
 * Registers the server with portkit if it's there, and resolves to the URL to
 * open the playground at when a proxy serves it: the one that started this
 * process, or else the one that just adopted it.
 */
export async function resolvePublicUrl(
  rootDir: string,
  port: number,
  options: { env?: NodeJS.ProcessEnv; run?: RunCommand } = {},
): Promise<string | undefined> {
  const { env = process.env } = options;
  const adoption = await adoptIntoPortkit(rootDir, port, options);
  return env.PORTKIT_URL ?? env.PORTLESS_URL ?? adoption?.url;
}
