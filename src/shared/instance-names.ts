// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What a run's resource instance may be named — shared by the server, which
 * refuses anything else, and the client, which says so before sending. See
 * `specs/resource-instances.md` §A.2.
 */

/** Whether `name` is a valid instance name: `[A-Za-z_][A-Za-z0-9_-]*`. */
export function isValidInstanceName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}
