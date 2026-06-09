import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { findAvailablePort } from './find-port.ts';

describe('findAvailablePort', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  /** Occupies `port` on 127.0.0.1 for the duration of a test. */
  const occupy = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      servers.push(s);
      s.once('error', reject).listen(port, '127.0.0.1', () => resolve());
    });

  it('returns the preferred port when it is free', async () => {
    // 45123 is almost certainly free in the test environment; a free preferred
    // port is returned unchanged.
    const port = await findAvailablePort(45123, '127.0.0.1');
    expect(port).toBe(45123);
  });

  it('falls back to the next free port when the preferred is taken', async () => {
    const base = await findAvailablePort(40000, '127.0.0.1');
    await occupy(base);
    const next = await findAvailablePort(base, '127.0.0.1');
    expect(next).toBeGreaterThan(base);
  });

  it('throws when no port is free in range', async () => {
    const base = await findAvailablePort(41000, '127.0.0.1');
    await occupy(base);
    await expect(findAvailablePort(base, '127.0.0.1', 1)).rejects.toThrow(
      /No free port/,
    );
  });
});
