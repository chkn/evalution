// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import net from "node:net";
import { DEFAULT_HOST } from "../server/listen-address.ts";

/** Probes whether `port` can be bound on `host`, resolving to `true` if free. */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net
      .createServer()
      .once("error", () => {
        // EADDRINUSE (and EACCES for privileged ports) mean "not usable here";
        // anything else we also treat as unusable and move on.
        resolve(false);
        tester.close();
      })
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, host);
  });
}

/**
 * Returns the first free port at or after `preferred`, scanning upward. Used by
 * the CLI so `npx evalution` still starts when the default port is already in
 * use instead of crashing with `EADDRINUSE`.
 *
 * A port counts as free only if it can be bound on `0.0.0.0` too: on macOS,
 * binding `127.0.0.1` succeeds even while another server holds the port on
 * every interface, and the playground's `localhost` URL would then reach that
 * server instead.
 *
 * @param preferred - The port to try first.
 * @param host - The host to bind against; defaults to {@link DEFAULT_HOST}.
 * @param maxAttempts - How many sequential ports to try before giving up.
 * @throws If no free port is found within `maxAttempts`.
 */
export async function findAvailablePort(
  preferred: number,
  host = DEFAULT_HOST,
  maxAttempts = 20,
): Promise<number> {
  for (let port = preferred; port < preferred + maxAttempts; port++) {
    if (
      (await isPortFree(port, host)) &&
      (host === "0.0.0.0" || (await isPortFree(port, "0.0.0.0")))
    )
      return port;
  }
  throw new Error(
    `No free port found in range ${preferred}-${preferred + maxAttempts - 1}`,
  );
}
