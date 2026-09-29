// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { parseThemeSetting, resolveTheme } from "./theme.ts";

describe("parseThemeSetting", () => {
  it("passes through light and dark", () => {
    expect(parseThemeSetting("light")).toBe("light");
    expect(parseThemeSetting("dark")).toBe("dark");
  });

  it("falls back to system for anything else", () => {
    expect(parseThemeSetting("system")).toBe("system");
    expect(parseThemeSetting("")).toBe("system");
    expect(parseThemeSetting("dark-mode")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("an explicit choice always wins over the OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("system follows the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
