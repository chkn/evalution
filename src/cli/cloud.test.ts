// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { Evalution, EvalutionApiError } from "@evalution/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectInstance,
  type InstanceClient,
  instanceRegistration,
  linkedCloudClient,
} from "./cloud.ts";

const quiet = () => ({ log: vi.fn(), warn: vi.fn() });

describe("linkedCloudClient", () => {
  const cloud = { project: "prj_1" };

  it("is a client for a linked project with a personal key", () => {
    expect(
      linkedCloudClient(
        { cloud },
        { env: { EVALUTION_API_KEY: "evl_user_x" }, log: quiet() },
      ),
    ).toBeInstanceOf(Evalution);
  });

  it.each([
    [{}],
    [{ EVALUTION_API_KEY: "evl_ingest_x" }],
    [{ EVALUTION_API_KEY: "nonsense" }],
  ])("is nothing without a personal key: %j", env => {
    expect(linkedCloudClient({ cloud }, { env, log: quiet() })).toBeUndefined();
  });

  it("suggests linking when there's a personal key but no project", () => {
    const log = quiet();
    expect(
      linkedCloudClient({}, { env: { EVALUTION_API_KEY: "evl_user_x" }, log }),
    ).toBeUndefined();
    expect(log.log.mock.calls[0][0]).toContain("evalution link");
  });
});

describe("instanceRegistration", () => {
  const base = {
    rootDir: "/work/app",
    localUrl: "http://localhost:3000",
    hostname: "laptop",
  };

  it("names the checkout by machine and folder", () => {
    const a = instanceRegistration(base);
    expect(a).toMatchObject({
      label: "laptop:app",
      localUrl: "http://localhost:3000",
    });
    expect(a?.instanceKey).toMatch(/^[0-9a-f]{64}$/);
    expect(instanceRegistration(base)?.instanceKey).toBe(a?.instanceKey);
    expect(
      instanceRegistration({ ...base, rootDir: "/work/other" })?.instanceKey,
    ).not.toBe(a?.instanceKey);
    expect(
      instanceRegistration({ ...base, hostname: "desktop" })?.instanceKey,
    ).not.toBe(a?.instanceKey);
  });

  it("includes where portkit serves it", () => {
    expect(
      instanceRegistration({
        ...base,
        portkit: { url: "https://app.evalution.localhost", mode: "on_demand" },
      }),
    ).toMatchObject({
      portkitUrl: "https://app.evalution.localhost",
      portkitMode: "on_demand",
    });
  });

  it("leaves out a proxy URL that isn't on this machine", () => {
    const registration = instanceRegistration({
      ...base,
      portkit: { url: "https://app.tailnet.ts.net" },
    });
    expect(registration).toBeDefined();
    expect(registration).not.toHaveProperty("portkitUrl");
  });

  it("is nothing for a server that isn't on loopback", () => {
    expect(
      instanceRegistration({ ...base, localUrl: "http://192.168.1.5:3000" }),
    ).toBeUndefined();
  });
});

describe("connectInstance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const registration = {
    instanceKey: "k",
    label: "laptop:app",
    localUrl: "http://localhost:3000",
  };
  const PROJECT_URL = "https://app--octo.local.evalut.io";
  const OPEN_URL = "https://evalut.io/cloud/remember/ins_1";

  function fakeClient() {
    return {
      registerInstance: vi.fn(async () => ({
        id: "ins_1",
        projectUrl: PROJECT_URL,
        openUrl: OPEN_URL,
      })),
      heartbeatInstance: vi.fn(async (_id: string) => {}),
      endInstanceSession: vi.fn(async (_id: string) => {}),
      printableApiKey: "evl_user_f00b4r",
    } satisfies InstanceClient;
  }

  const options = { project: "prj_1", intervalMs: 1000 };

  it("registers, prints the project URL, then heartbeats", async () => {
    const client = fakeClient();
    const log = quiet();
    const instance = connectInstance(client, registration, {
      ...options,
      log,
    });
    await instance.ready;
    expect(client.registerInstance).toHaveBeenCalledWith(registration);
    expect(instance.projectUrl).toBe(PROJECT_URL);
    expect(instance.openUrl).toBe(OPEN_URL);
    expect(log.log).toHaveBeenCalledWith(`🔗 Share links from ${PROJECT_URL}`);

    await vi.advanceTimersByTimeAsync(2000);
    expect(client.heartbeatInstance).toHaveBeenCalledTimes(2);
    expect(client.heartbeatInstance).toHaveBeenCalledWith("ins_1");
    expect(client.registerInstance).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledTimes(1);
  });

  it("registers again when the cloud has dropped it", async () => {
    const client = fakeClient();
    const instance = connectInstance(client, registration, {
      ...options,
      log: quiet(),
    });
    await instance.ready;
    client.heartbeatInstance.mockRejectedValueOnce(new EvalutionApiError(404));
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.registerInstance).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying when the cloud can't be reached, warning once", async () => {
    const client = fakeClient();
    client.registerInstance.mockRejectedValue(new Error("fetch failed"));
    const log = quiet();
    const instance = connectInstance(client, registration, {
      ...options,
      log,
    });
    await instance.ready;
    expect(instance.projectUrl).toBeUndefined();
    expect(instance.openUrl).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.registerInstance).toHaveBeenCalledTimes(4);
    expect(log.warn).toHaveBeenCalledTimes(1);

    client.registerInstance.mockResolvedValue({
      id: "ins_1",
      projectUrl: PROJECT_URL,
      openUrl: OPEN_URL,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(instance.projectUrl).toBe(PROJECT_URL);
  });

  it.each([
    [404, "evalution link"],
    [401, "EVALUTION_API_KEY"],
  ])("gives up on a %d", async (status, hint) => {
    const client = fakeClient();
    client.registerInstance.mockRejectedValue(new EvalutionApiError(status));
    const log = quiet();
    await connectInstance(client, registration, { ...options, log }).ready;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.registerInstance).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const output = [...log.warn.mock.calls, ...log.log.mock.calls]
      .flat()
      .join("\n");
    expect(output).toContain(hint);
  });

  it("ends the session on stop, and stops beating", async () => {
    const client = fakeClient();
    const instance = connectInstance(client, registration, {
      ...options,
      log: quiet(),
    });
    await instance.ready;
    await instance.stop();
    expect(client.endInstanceSession).toHaveBeenCalledWith("ins_1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.heartbeatInstance).not.toHaveBeenCalled();
  });

  it("ends a session whose registration was still in flight on stop", async () => {
    const client = fakeClient();
    let answer = () => {};
    client.registerInstance.mockReturnValueOnce(
      new Promise(resolve => {
        answer = () =>
          resolve({ id: "ins_1", projectUrl: PROJECT_URL, openUrl: OPEN_URL });
      }),
    );
    const instance = connectInstance(client, registration, {
      ...options,
      log: quiet(),
    });
    const stopped = instance.stop();
    answer();
    await stopped;
    expect(client.endInstanceSession).toHaveBeenCalledWith("ins_1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.heartbeatInstance).not.toHaveBeenCalled();
  });

  it("doesn't let a cloud that never answers hold up exiting", async () => {
    const client = fakeClient();
    client.endInstanceSession.mockReturnValue(new Promise(() => {}));
    const instance = connectInstance(client, registration, {
      ...options,
      log: quiet(),
    });
    await instance.ready;
    const stopped = instance.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(stopped).resolves.toBeUndefined();
  });
});
