// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { syncingLists } from "./sync-status";

describe("syncingLists", () => {
  it("shows nothing when nothing is being brought into sync", () => {
    expect(syncingLists([])).toEqual({
      traces: false,
      evals: false,
      datasets: new Set(),
    });
  });

  it("sorts each database by the list that shows it", () => {
    expect(
      syncingLists([
        { kind: "traces", provider: "local-db" },
        { kind: "dataset", provider: "local-datasets", key: "tickets" },
        { kind: "dataset", provider: "shared", key: "tickets" },
      ]),
    ).toEqual({
      traces: true,
      evals: false,
      datasets: new Set(["local-datasets:tickets", "shared:tickets"]),
    });
  });
});
