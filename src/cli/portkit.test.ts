// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it, vi } from "vitest";
import {
  adoptIntoPortkit,
  portkitServiceName,
  type RunCommand,
  resolvePublicUrl,
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

describe("resolvePublicUrl", () => {
  it("is portkit's URL once adopted", async () => {
    await expect(
      resolvePublicUrl("/work/app", 4100, { env: {}, run: adopted() }),
    ).resolves.toBe("https://app.evalution.localhost");
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
    ).resolves.toBe("https://named.localhost");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a portless URL", async () => {
    await expect(
      resolvePublicUrl("/work/app", 4100, {
        env: { PORTLESS_URL: "https://less.localhost" },
        run: adopted(),
      }),
    ).resolves.toBe("https://less.localhost");
  });
});
