import net from 'node:net';

/** Probes whether `port` can be bound on `host`, resolving to `true` if free. */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE (and EACCES for privileged ports) mean "not usable here";
        // anything else we also treat as unusable and move on.
        resolve(false);
        tester.close();
      })
      .once('listening', () => {
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
 * @param preferred - The port to try first.
 * @param host - The host to bind against; defaults to `0.0.0.0`.
 * @param maxAttempts - How many sequential ports to try before giving up.
 * @throws If no free port is found within `maxAttempts`.
 */
export async function findAvailablePort(
  preferred: number,
  host = '0.0.0.0',
  maxAttempts = 20,
): Promise<number> {
  for (let port = preferred; port < preferred + maxAttempts; port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(
    `No free port found in range ${preferred}-${preferred + maxAttempts - 1}`,
  );
}
