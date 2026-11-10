// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { HttpTraceSink, type HttpTraceTarget } from "./http-trace-sink.ts";
import type { TraceSink } from "./trace-sink.ts";
import type { Span, TraceSummary, TraceWithSpans } from "./trace-types.ts";

/** The Evalution Cloud API, unless `EVALUTION_API_URL` says otherwise. */
export const DEFAULT_API_URL = "https://api.evalut.io";

/**
 * What an API key can do: an `ingest` key writes one project's production
 * traces and nothing else, and a `personal` key reads and manages a user's
 * projects but can't write production traces.
 */
export type ApiKeyKind = "ingest" | "personal";

/**
 * The kind of an API key, read from its prefix, or `undefined` for a string
 * that isn't one.
 */
export function apiKeyKind(key: string): ApiKeyKind | undefined {
  if (key.startsWith("evl_ingest_")) return "ingest";
  if (key.startsWith("evl_user_")) return "personal";
  return undefined;
}

/** Options for {@link Evalution}. Each overrides what the environment says. */
export interface EvalutionOptions {
  /**
   * The base URL of a local Evalution instance to send traces to, without
   * authentication.
   * - If this is set, traces always go to this local instance, or nowhere if
   * this is `false`.
   * - Otherwise, if an ingest API key is present, traces always go to the cloud.
   * - Otherwise, this defaults to `EVALUTION_ENDPOINT`.
   */
  endpoint?: string | false;
  /**
   * API key for Evalution Cloud.
   * - An ingest key sends traces to the cloud.
   * - A personal key makes the read and control calls available, and traces go
   * to a local instance.
   *
   * Defaults to `EVALUTION_API_KEY`.
   */
  apiKey?: string;
  /** The cloud's base URL. Defaults to `EVALUTION_API_URL`, then {@link DEFAULT_API_URL}. */
  apiUrl?: string;
  /** The project id the read and control calls act on: the config's `cloud.project`. */
  project?: string;
  /** The `fetch` to send with. Defaults to the global one. */
  fetch?: typeof fetch;
}

/** Which traces {@link Evalution.listTraces} returns. */
export interface ListTracesQuery {
  /** Only traces from this deployment environment. */
  environment?: string;
  /** Only traces started at or after this time (ms). */
  from?: number;
  /** Only traces started before this time (ms). */
  to?: number;
  /** At most this many, most recent first. */
  limit?: number;
}

/** A project, as the cloud describes it. */
export interface CloudProject {
  /** The `prj_…` id committed in a repo's config. */
  id: string;
  slug: string;
  name: string;
}

/** What {@link Evalution.whoami} resolves a key to. */
export type CloudIdentity =
  | { kind: "personal"; userId: string }
  | { kind: "ingest"; projectId: string; environment: string };

/** One checkout of a project, as {@link Evalution.registerInstance} reports it. */
export interface InstanceRegistration {
  /** Identifies this checkout: the same folder is always the same instance. */
  instanceKey: string;
  /** How to show this instance in a list, e.g. `hostname:dir`. */
  label: string;
  /** The instance's own loopback URL. */
  localUrl: string;
  /** Its portkit URL, if it has one. */
  portkitUrl?: string;
  /** How portkit runs it, if it does. */
  portkitMode?: string;
}

/** The cloud's answer to {@link Evalution.registerInstance}. */
export interface RegisteredInstance {
  id: string;
  /** The project's shareable `*.local.evalut.io` URL. */
  projectUrl: string;
}

/** Names one synced database of a project. */
export interface SyncDatabaseKey {
  kind: "traces" | "evals" | "dataset";
  /** The dataset's id, for `kind: "dataset"`. */
  key?: string;
}

/** Where a synced database lives, and a short-lived token for it. */
export interface SyncDatabaseCredentials {
  url: string;
  token: string;
  /** When {@link token} expires (ms). */
  expiresAt: number;
}

/**
 * The client for Evalution's API. As a {@link TraceSink} it sends an app's
 * traces, and it makes the read and control calls the local server needs.
 *
 * Where traces go is worked out once, on the first one sent:
 *
 * 1. the {@link EvalutionOptions.endpoint} option;
 * 2. the cloud, when the API key is an ingest key;
 * 3. the local instance `EVALUTION_ENDPOINT` names;
 * 4. on Node, the instance portkit knows for this directory;
 * 5. otherwise nowhere, and sending does nothing.
 *
 * A personal key never sends traces to the cloud, and no key is ever sent to
 * a local instance. Tracing never breaks the app: see {@link HttpTraceSink},
 * and await {@link flush} before a short-lived process exits. The read and
 * control calls, by contrast, reject when they fail.
 */
export class Evalution implements TraceSink {
  private readonly endpoint?: string | false;
  private readonly apiKey?: string;
  private readonly apiUrl: string;
  private readonly project?: string;
  private readonly fetch: typeof fetch;
  private readonly sink: HttpTraceSink;

  constructor(options: EvalutionOptions = {}) {
    // `process` is absent in some runtimes (e.g. Cloudflare Workers).
    const env = globalThis.process?.env ?? {};
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey ?? env.EVALUTION_API_KEY;
    this.apiUrl = (
      options.apiUrl ||
      env.EVALUTION_API_URL ||
      DEFAULT_API_URL
    ).replace(/\/+$/, "");
    this.project = options.project;
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.sink = new HttpTraceSink({
      endpoint: () => this.resolveTraceTarget(env.EVALUTION_ENDPOINT),
      fetch: this.fetch,
    });
  }

  private async resolveTraceTarget(
    envEndpoint: string | undefined,
  ): Promise<HttpTraceTarget | undefined> {
    if (this.endpoint === false) return undefined;
    if (this.endpoint) return { endpoint: this.endpoint };
    if (this.apiKey) {
      const keyKind = apiKeyKind(this.apiKey);
      switch (keyKind) {
        case "ingest":
          return {
            endpoint: this.apiUrl,
            headers: { authorization: `Bearer ${this.apiKey}` },
          };
        case "personal":
          break;
        default: {
          const _guard: undefined = keyKind;
          console.warn(
            "[evalution] Ignoring the API key: it isn't an evl_ingest_… or evl_user_… key.",
          );
        }
      }
    }
    if (envEndpoint) return { endpoint: envEndpoint };
    if (!globalThis.process?.versions?.node) return undefined;
    return (await import("./portkit.ts")).discoverPortkit();
  }

  recordSpanStart(span: Span): Promise<Span> {
    return this.sink.recordSpanStart(span);
  }

  recordSpanEnd(span: Span): Promise<Span> {
    return this.sink.recordSpanEnd(span);
  }

  failTrace(traceId: string, errorMessage: string): Promise<void> {
    return this.sink.failTrace(traceId, errorMessage);
  }

  /** Resolves once every trace event recorded so far has been sent (or dropped). */
  flush(): Promise<void> {
    return this.sink.flush();
  }

  /** The key's kind and whose it is. Takes either kind of key. */
  whoami(): Promise<CloudIdentity> {
    return this.json("GET", "/cloud/v1/whoami", { key: "any" });
  }

  /** The most recent production traces of the project. */
  listTraces(query: ListTracesQuery = {}): Promise<TraceSummary[]> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    const search = params.size > 0 ? `?${params}` : "";
    return this.json("GET", `/api/traces${search}`, { project: true });
  }

  /** One production trace with its spans, or `undefined` if there's none. */
  async getTrace(id: string): Promise<TraceWithSpans | undefined> {
    const res = await this.request(
      "GET",
      `/api/traces/${encodeURIComponent(id)}`,
      { project: true },
    );
    if (res.status === 404) return undefined;
    return (await readOk(res)).json() as Promise<TraceWithSpans>;
  }

  /** The projects the key's user is a member of. */
  listProjects(): Promise<CloudProject[]> {
    return this.json("GET", "/cloud/v1/projects");
  }

  /** Creates a project in the user's organization. */
  createProject(project: {
    name: string;
    slug?: string;
  }): Promise<CloudProject> {
    return this.json("POST", "/cloud/v1/projects", { body: project });
  }

  /** Records a running checkout of the project. */
  registerInstance(
    instance: InstanceRegistration,
  ): Promise<RegisteredInstance> {
    return this.json("PUT", "/cloud/v1/instances", {
      project: true,
      body: instance,
    });
  }

  /** Tells the cloud a registered instance is still running. */
  async heartbeatInstance(id: string): Promise<void> {
    await readOk(await this.instanceRequest("POST", id, "heartbeat"));
  }

  /** Tells the cloud a registered instance has stopped. */
  async endInstanceSession(id: string): Promise<void> {
    await readOk(await this.instanceRequest("DELETE", id, "session"));
  }

  /** Ensures a synced database exists, and returns how to reach it. */
  getSyncDatabase(key: SyncDatabaseKey): Promise<SyncDatabaseCredentials> {
    return this.json("POST", "/cloud/v1/sync/databases", {
      project: true,
      body: key,
    });
  }

  private instanceRequest(
    method: string,
    id: string,
    action: string,
  ): Promise<Response> {
    const path = `/cloud/v1/instances/${encodeURIComponent(id)}/${action}`;
    return this.request(method, path, { project: true });
  }

  private async json<T>(
    method: string,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<T> {
    const res = await readOk(await this.request(method, path, options));
    return res.json() as Promise<T>;
  }

  private request(
    method: string,
    path: string,
    { key = "personal", project, body }: CloudRequestOptions = {},
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new Error("Evalution: set EVALUTION_API_KEY to use the cloud API.");
    }
    if (key === "personal" && apiKeyKind(this.apiKey) !== "personal") {
      throw new Error(`Evalution: ${path} needs a personal (evl_user_…) key.`);
    }
    if (project && !this.project) {
      throw new Error(`Evalution: ${path} needs a project id.`);
    }
    return this.fetch(this.apiUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(project && { "evalution-project": this.project }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
}

/** How {@link Evalution} makes one request of the cloud. */
interface CloudRequestOptions {
  /** Which keys may make the call. Defaults to `personal`. */
  key?: "personal" | "any";
  /** Whether the call acts on the client's project. */
  project?: boolean;
  /** Sent as JSON. */
  body?: unknown;
}

/** `res`, or a rejection saying why the cloud refused. */
async function readOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  const detail = await res.text().catch(() => "");
  throw new Error(`Evalution API: ${res.status} ${detail}`.trim());
}
