// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** A trace a link names: the provider it's in, and its id. */
export interface LinkedTrace {
  providerId: string;
  traceId: string;
}

/**
 * The link to share a trace by: the project's Evalution Cloud URL, which
 * opens each member's own playground, at `?trace=<id>&provider=<id>`.
 */
export function traceLink(projectUrl: string, trace: LinkedTrace): string {
  const url = new URL(projectUrl);
  url.pathname = "/";
  url.search = new URLSearchParams({
    trace: trace.traceId,
    provider: trace.providerId,
  }).toString();
  return url.toString();
}

/** The trace a page's query string names, if it names one. */
export function linkedTrace(search: string): LinkedTrace | undefined {
  const params = new URLSearchParams(search);
  const traceId = params.get("trace");
  const providerId = params.get("provider");
  return traceId && providerId ? { traceId, providerId } : undefined;
}
