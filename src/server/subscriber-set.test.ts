// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { SubscriberSet } from "./subscriber-set.ts";

describe("SubscriberSet", () => {
  it("says when it gains its first subscriber and loses its last", () => {
    const calls: string[] = [];
    const set = new SubscriberSet<string>({
      onFirst: () => calls.push("first"),
      onEmpty: () => calls.push("empty"),
    });

    set.add("a");
    set.add("b");
    set.add("a");
    set.delete("a");
    set.delete("missing");
    set.delete("b");
    set.add("c");
    set.clear();
    set.clear();

    expect(calls).toEqual(["first", "empty", "first", "empty"]);
  });
});
