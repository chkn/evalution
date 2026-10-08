// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, serverUrl } from "./listen-address.ts";

describe("serverUrl", () => {
  it("reaches the default loopback address as localhost", () => {
    expect(serverUrl(DEFAULT_HOST, 3000)).toBe("http://localhost:3000");
  });

  it.each(["0.0.0.0", "::"])("reaches the wildcard %s as localhost", host => {
    expect(serverUrl(host, 3000)).toBe("http://localhost:3000");
  });

  it("brackets an IPv6 address", () => {
    expect(serverUrl("::1", 3000)).toBe("http://[::1]:3000");
  });

  it("uses any other address or name as given", () => {
    expect(serverUrl("192.168.1.5", 3000)).toBe("http://192.168.1.5:3000");
    expect(serverUrl("devbox.local", 3000)).toBe("http://devbox.local:3000");
  });
});
