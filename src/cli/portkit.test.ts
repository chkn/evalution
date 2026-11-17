// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import {
  adoptIntoPortkit,
  portkitServiceName,
  preparePortkit,
  type RunCommand,
  resolvePublicUrl,
  startedOnDemand,
} from "./portkit.ts";

const adopted = (url = "https://app.evalution.localhost") =>
  vi.fn<Parameters<RunCommand>, ReturnType<RunCommand>>(async () => ({
    stdout: JSON.stringify({
      name: "app.evalution",
      url,
      action: "created",
      record: { mode: "adopted" },
    }),
  }));

const missing = vi.fn<Parameters<RunCommand>, ReturnType<RunCommand>>(
  async () => {
    throw Object.assign(new Error("spawn portkit ENOENT"), { code: "ENOENT" });
  },
);

describe("portkitServiceName", () => {
  it.each([
    ["/work/my-app", "my-app.evalution"],
    ["/work/My App_2", "my-app-2.evalution"],
    ["/work/--x--", "x.evalution"],
    ["/work/___", "evalution"],
    [`/work/${"a".repeat(70)}`, `${"a".repeat(63)}.evalution`],
    [`/work/${"a".repeat(62)}_b`, `${"a".repeat(62)}.evalution`],
  ])("names %s %s", (dir, name) => {
    expect(portkitServiceName(dir)).toBe(name);
  });
});

describe("adoptIntoPortkit", () => {
  it("adopts the port with the evalution label, from the project", async () => {
    const run = adopted();

    await expect(
      adoptIntoPortkit("/work/app", 4100, { env: {}, run }),
    ).resolves.toEqual({
      url: "https://app.evalution.localhost",
      mode: "adopted",
    });

    expect(run).toHaveBeenCalledWith(
      "portkit",
      ["adopt", "app.evalution", "4100", "--label", "kind=evalution", "--json"],
      expect.objectContaining({ cwd: "/work/app" }),
    );
  });

  it("uses portkit's own binary when portkit started this process", async () => {
    const run = adopted();

    await adoptIntoPortkit("/work/app", 4100, {
      env: { PORTKIT_HOME: "/pk" },
      run,
    });

    expect(run.mock.calls[0][0]).toBe("/pk/bin/caddy");
    expect(run.mock.calls[0][1].slice(0, 2)).toEqual(["portkit", "adopt"]);
  });

  it("ignores any failure", async () => {
    await expect(
      adoptIntoPortkit("/work/app", 4100, { env: {}, run: missing }),
    ).resolves.toBeUndefined();

    const garbled = vi.fn<Parameters<RunCommand>, ReturnType<RunCommand>>(
      async () => ({ stdout: "not json" }),
    );
    await expect(
      adoptIntoPortkit("/work/app", 4100, { env: {}, run: garbled }),
    ).resolves.toBeUndefined();
  });
});

describe("startedOnDemand", () => {
  const onDemand = {
    url: "https://app.evalution.localhost",
    mode: "on_demand",
  };

  it("is when portkit started it for a visit", () => {
    expect(
      startedOnDemand(onDemand, {
        PORTKIT_URL: "https://app.evalution.localhost",
      }),
    ).toBe(true);
  });

  it.each([
    ["run by hand while an on-demand record waits", onDemand, {}],
    [
      "started in another mode",
      { url: "https://app.evalution.localhost", mode: "foreground" },
      { PORTKIT_URL: "https://app.evalution.localhost" },
    ],
    ["without portkit", undefined, {}],
  ])("isn't when %s", (_name, adoption, env) => {
    expect(startedOnDemand(adoption, env)).toBe(false);
  });
});

describe("resolvePublicUrl", () => {
  it("is portkit's URL once adopted", async () => {
    await expect(
      resolvePublicUrl("/work/app", 4100, { env: {}, run: adopted() }),
    ).resolves.toEqual({
      url: "https://app.evalution.localhost",
      mode: "adopted",
    });
  });

  it("is undefined without portkit or portless", async () => {
    await expect(
      resolvePublicUrl("/work/app", 4100, { env: {}, run: missing }),
    ).resolves.toBeUndefined();
  });

  it("prefers the proxy that started it, but still adopts for the label", async () => {
    const run = adopted("https://elsewhere.localhost");

    await expect(
      resolvePublicUrl("/work/app", 4100, {
        env: { PORTKIT_URL: "https://named.localhost" },
        run,
      }),
    ).resolves.toEqual({ url: "https://named.localhost", mode: "adopted" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a portless URL", async () => {
    await expect(
      resolvePublicUrl("/work/app", 4100, {
        env: { PORTLESS_URL: "https://less.localhost" },
        run: adopted(),
      }),
    ).resolves.toMatchObject({ url: "https://less.localhost" });
  });
});

describe("preparePortkit", () => {
  /**
   * Like portkit with an on-demand record that started this process: it
   * refuses to merge an adoption until the server is listening.
   */
  const onDemandPortkit = () => {
    const state = { listening: false };
    const run = vi.fn<Parameters<RunCommand>, ReturnType<RunCommand>>(
      async () => {
        if (!state.listening) {
          throw new Error(
            "portkit: app.evalution.localhost already belongs to a running on demand service on another port; pick another name",
          );
        }
        return {
          stdout: JSON.stringify({
            action: "merged",
            name: "app.evalution",
            url: "https://app.evalution.localhost",
            record: { mode: "on_demand" },
          }),
        };
      },
    );
    return { state, run };
  };
  const startedByPortkit = {
    PORTKIT_URL: "https://app.evalution.localhost",
    PORTKIT_HOME: "/pk",
  };

  it("keeps the on-demand mode by adopting only once the server listens", async () => {
    const { state, run } = onDemandPortkit();

    const plan = await preparePortkit("/work/app", 4100, {
      env: startedByPortkit,
      run,
    });
    expect(plan.publicUrl).toBe("https://app.evalution.localhost");
    expect(run).not.toHaveBeenCalled();

    state.listening = true;
    const adoption = await plan.adoption();
    expect(adoption).toEqual({
      url: "https://app.evalution.localhost",
      mode: "on_demand",
    });
    expect(startedOnDemand(adoption, startedByPortkit)).toBe(true);
  });

  it("adopts once however often it's asked", async () => {
    const { state, run } = onDemandPortkit();
    state.listening = true;

    const plan = await preparePortkit("/work/app", 4100, {
      env: startedByPortkit,
      run,
    });
    await plan.adoption();
    await plan.adoption();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks portkit up front when no proxy started it, for the URL", async () => {
    const run = adopted();

    const plan = await preparePortkit("/work/app", 4100, { env: {}, run });

    expect(plan.publicUrl).toBe("https://app.evalution.localhost");
    expect(run).toHaveBeenCalledTimes(1);
    await expect(plan.adoption()).resolves.toEqual({
      url: "https://app.evalution.localhost",
      mode: "adopted",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("has no URL without portkit", async () => {
    const plan = await preparePortkit("/work/app", 4100, {
      env: {},
      run: missing,
    });

    expect(plan.publicUrl).toBeUndefined();
    await expect(plan.adoption()).resolves.toBeUndefined();
  });
});
