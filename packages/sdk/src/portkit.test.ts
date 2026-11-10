// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPortkit, localTlsFetch } from "./portkit.ts";

// A self-signed certificate for portkit.localhost and app.evalution.localhost,
// generated for these tests alone, valid until 2126.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgspM7fAjkXgpuSl1p
/3Y24IiUGCGZ8+VDOhe62BphJuuhRANCAASQpCG3cO0rev3CDZJO21qWctX2mLSY
3VScp3+jgQ/RxJjheCvJ8SRVFfLddVgsw3UtdvBpJ8I94/EYbTkwohmS
-----END PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBwjCCAWigAwIBAgIUcV/MxEURFmh4fMWXvtSzNaIo3lgwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOZXZhbHV0aW9uIHRlc3QwIBcNMjYxMTEwMDk0ODE0WhgPMjEy
NjEwMTcwOTQ4MTRaMBkxFzAVBgNVBAMMDmV2YWx1dGlvbiB0ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEkKQht3DtK3r9wg2STttalnLV9pi0mN1UnKd/o4EP
0cSY4XgryfEkVRXy3XVYLMN1LXbwaSfCPePxGG05MKIZkqOBizCBiDAdBgNVHQ4E
FgQUKSdj/YSq9KoeRqwtVTmNUjRnmvMwHwYDVR0jBBgwFoAUKSdj/YSq9KoeRqwt
VTmNUjRnmvMwDwYDVR0TAQH/BAUwAwEB/zA1BgNVHREELjAsghFwb3J0a2l0Lmxv
Y2FsaG9zdIIXYXBwLmV2YWx1dGlvbi5sb2NhbGhvc3QwCgYIKoZIzj0EAwIDSAAw
RQIhAMmvYgRg3Vhlzx/Q1kbWaAKKZI8tze+TlztHF9xvXKKWAiAleS7yw5WWTtlD
x0My6aoMuytsKzodE5HM+E0i/wILcA==
-----END CERTIFICATE-----
`;

interface Received {
  method?: string;
  url?: string;
  host?: string;
  servername?: string;
  body: string;
}

describe("portkit", () => {
  let server: Server;
  let port: number;
  let home: string;
  let received: Received[];
  let respond: (url: string) => { status: number; body?: string };

  beforeEach(async () => {
    received = [];
    respond = () => ({ status: 200, body: "{}" });
    server = createServer({ key: KEY, cert: CERT }, (req, res) => {
      let body = "";
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          servername: (req.socket as unknown as { servername?: string })
            .servername,
          body,
        });
        const answer = respond(req.url ?? "");
        res.writeHead(answer.status).end(answer.body);
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;

    home = await mkdtemp(join(tmpdir(), "evalution-portkit-"));
    const dir = join(home, "data/caddy/pki/authorities/local");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "root.crt"), CERT);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await rm(home, { recursive: true });
  });

  const discover = (env = { PORTKIT_HOME: home }) =>
    discoverPortkit({
      env,
      cwd: "/work/my app",
      servicesUrl: `https://portkit.localhost:${port}/services`,
    });

  const answerServices = (services: unknown[]) => {
    respond = () => ({ status: 200, body: JSON.stringify({ services }) });
  };

  it("makes no request without the CA certificate", async () => {
    await expect(
      discover({ PORTKIT_HOME: join(home, "absent") }),
    ).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });

  it("asks by label and directory, over loopback, under portkit's name", async () => {
    answerServices([]);

    await discover();

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("GET");
    expect(received[0].host).toBe(`portkit.localhost:${port}`);
    expect(received[0].servername).toBe("portkit.localhost");
    const query = new URL(received[0].url!, "https://x").searchParams;
    expect(query.get("label")).toBe("kind=evalution");
    expect(query.get("cwd")).toBe("/work/my app");
  });

  it("uses the first service, and can send to it with the same trust", async () => {
    answerServices([
      { url: `https://app.evalution.localhost:${port}` },
      { url: "https://other.localhost" },
    ]);

    const target = await discover();

    expect(target?.endpoint).toBe(`https://app.evalution.localhost:${port}`);
    const res = await target!.fetch!(`${target!.endpoint}/api/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"events":[]}',
    });
    expect(res.status).toBe(200);
    expect(received[1]).toMatchObject({
      method: "POST",
      url: "/api/traces",
      servername: "app.evalution.localhost",
      body: '{"events":[]}',
    });
  });

  it.each([
    ["no service matches", 200, JSON.stringify({ services: [] })],
    ["portkit errors", 500, "boom"],
    ["the answer isn't JSON", 200, "nope"],
  ])("finds nothing when %s", async (_name, status, body) => {
    respond = () => ({ status, body });

    await expect(discover()).resolves.toBeUndefined();
  });

  it("finds nothing when the server's certificate isn't from portkit's CA", async () => {
    const dir = join(home, "data/caddy/pki/authorities/local");
    // A valid PEM of some other root: Node's own first bundled CA would do,
    // but any certificate that didn't sign the server's is the point.
    const { rootCertificates } = await import("node:tls");
    await writeFile(join(dir, "root.crt"), rootCertificates[0]);

    await expect(discover()).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });

  it("gives up after its time budget", async () => {
    server.removeAllListeners("request");
    server.on("request", () => {}); // Never answers.
    const started = Date.now();

    await expect(discover()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("answers a response with no body", async () => {
    respond = () => ({ status: 204 });
    const res = await localTlsFetch(CERT)(
      `https://portkit.localhost:${port}/x`,
    );
    expect(res.status).toBe(204);
  });
});
