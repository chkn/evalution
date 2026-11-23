// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { matchingSlotPath } from "./input-references.ts";

describe("matchingSlotPath", () => {
  const slots = {
    after: ["pg.ts#seededTaskDependency"],
    "after.[]": ["pg.ts#seededTask.taskId"],
    "ctx.list.[].db": ["pg.ts#db"],
    "ctx.list.[]": [],
  };

  it("finds an element's slot from its index", () => {
    expect(matchingSlotPath(slots, "after.3")).toBe("after.[]");
    expect(matchingSlotPath(slots, "ctx.list.0.db")).toBe("ctx.list.[].db");
  });

  it("prefers a slot named exactly", () => {
    expect(matchingSlotPath(slots, "after")).toBe("after");
  });

  it("is undefined when there's no such slot", () => {
    expect(matchingSlotPath(slots, "label")).toBeUndefined();
    expect(matchingSlotPath(slots, "after.x")).toBeUndefined();
  });
});
