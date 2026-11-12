// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Registering a running playground with Evalution Cloud, so the project's
 * URL (`https://<project>--<org>.local.evalut.io`) can send its members to
 * their own running copy. See PLAN §7 in the cloud repo.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  apiKeyKind,
  Evalution,
  EvalutionApiError,
  type InstanceRegistration,
} from "@evalution/sdk";
import type { EvalutionConfig } from "../config.ts";
import type { PortkitAdoption } from "./portkit.ts";

/** How often a running instance tells the cloud it's still there. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** How long ending the session may hold up exiting. */
const END_SESSION_TIMEOUT_MS = 2000;

type Log = Pick<Console, "log" | "warn">;

/**
 * The cloud client for this project, when it's linked and there's a personal
 * key to act with; otherwise `undefined`. A personal key without a linked
 * project gets a hint to link one.
 */
export function linkedCloudClient(
  config: EvalutionConfig,
  {
    env = process.env,
    log = console,
  }: { env?: NodeJS.ProcessEnv; log?: Log } = {},
): Evalution | undefined {
  const apiKey = env.EVALUTION_API_KEY;
  if (!apiKey || apiKeyKind(apiKey) !== "personal") return undefined;
  const project = config.cloud?.project;
  if (!project) {
    log.log("💡 Run `evalution link` to link this project to Evalution Cloud.");
    return undefined;
  }
  return new Evalution({ apiKey, project, endpoint: false });
}

/** Whether `url` is on this machine, which is all the cloud will send a browser to. */
function isLoopbackUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { hostname } = new URL(url);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * What this checkout reports about itself, or `undefined` when it isn't
 * reachable at a loopback URL (it was started with `--host` naming another
 * interface), so a browser on this machine couldn't be sent to it.
 */
export function instanceRegistration({
  rootDir,
  localUrl,
  portkit,
  hostname = os.hostname(),
}: {
  rootDir: string;
  /** The server's own URL. */
  localUrl: string;
  /** Where a proxy serves it, if one does. */
  portkit?: PortkitAdoption;
  hostname?: string;
}): InstanceRegistration | undefined {
  if (!isLoopbackUrl(localUrl)) return undefined;
  // The same folder on the same machine is always the same instance, with
  // nothing to keep on disk.
  const instanceKey = createHash("sha256")
    .update(`${hostname}\0${rootDir}`)
    .digest("hex");
  return {
    instanceKey,
    label: `${hostname}:${path.basename(rootDir)}`,
    localUrl,
    ...(portkit &&
      isLoopbackUrl(portkit.url) && {
        portkitUrl: portkit.url,
        portkitMode: portkit.mode,
      }),
  };
}

/** A registered instance, from {@link connectInstance}. */
export interface CloudInstance {
  /** The project's shareable URL, once the cloud has said what it is. */
  readonly projectUrl: string | undefined;
  /**
   * Where to open the playground in this machine's browser, once registered:
   * through the cloud, which remembers this instance in that browser so the
   * project URL goes straight to it.
   */
  readonly openUrl: string | undefined;
  /** Settles once the first registration attempt has, whatever its outcome. */
  readonly ready: Promise<void>;
  /** Stops heartbeating and tells the cloud this instance has stopped. */
  stop(): Promise<void>;
}

/** The calls {@link connectInstance} makes. */
export type InstanceClient = Pick<
  Evalution,
  | "registerInstance"
  | "heartbeatInstance"
  | "endInstanceSession"
  | "printableApiKey"
>;

/**
 * Registers this instance and keeps it registered, with a heartbeat. Nothing
 * here can stop the playground starting: a failure is reported, and retried
 * on the next beat unless retrying can't help.
 */
export function connectInstance(
  client: InstanceClient,
  registration: InstanceRegistration,
  {
    project,
    intervalMs = HEARTBEAT_INTERVAL_MS,
    log = console,
  }: { project: string; intervalMs?: number; log?: Log },
): CloudInstance {
  let id: string | undefined;
  let projectUrl: string | undefined;
  let openUrl: string | undefined;
  let stopped = false;
  let warned = false;
  let timer: NodeJS.Timeout | undefined;

  const beat = async () => {
    if (id) {
      try {
        await client.heartbeatInstance(id);
        return;
      } catch (err) {
        // The cloud dropped the row: register again.
        if (!(err instanceof EvalutionApiError && err.status === 404))
          throw err;
        id = undefined;
      }
    }
    const registered = await client.registerInstance(registration);
    id = registered.id;
    if (projectUrl !== registered.projectUrl) {
      log.log(`🔗 Share links from ${registered.projectUrl}`);
    }
    projectUrl = registered.projectUrl;
    openUrl = registered.openUrl;
  };

  const tick = async () => {
    try {
      await beat();
      warned = false;
    } catch (err) {
      const status = err instanceof EvalutionApiError ? err.status : undefined;
      if (status === 404) {
        log.warn(
          `⚠️ Your EVALUTION_API_KEY (${client.printableApiKey}) cannot access the Evalution Cloud project ${project} linked from .evalution/config.ts.`,
        );
        log.log("");
        log.log("💡 Run `evalution link` to link a project of your own.");
        stopped = true;
      } else if (status === 401 || status === 403) {
        log.warn(
          "⚠️ Evalution Cloud didn't accept EVALUTION_API_KEY, so this playground has no project URL.",
        );
        stopped = true;
      } else if (!warned) {
        log.warn(
          `⚠️ Couldn't register with Evalution Cloud (${(err as Error).message}); retrying.`,
        );
        warned = true;
      }
    }
  };

  // The beat in flight, if any: `tick` never rejects.
  let current: Promise<void> = Promise.resolve();
  const loop = async () => {
    current = tick();
    await current;
    if (!stopped) timer = setTimeout(loop, intervalMs).unref();
  };

  return {
    get projectUrl() {
      return projectUrl;
    },
    get openUrl() {
      return openUrl;
    },
    ready: loop(),
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const ending = (async () => {
        // A registration still in flight would otherwise land after we've
        // gone, leaving the cloud sending browsers here until it times out.
        await current;
        if (id) await client.endInstanceSession(id);
      })().catch(() => {});
      await Promise.race([
        ending,
        new Promise(resolve =>
          setTimeout(resolve, END_SESSION_TIMEOUT_MS).unref(),
        ),
      ]);
    },
  };
}
