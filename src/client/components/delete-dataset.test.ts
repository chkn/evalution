// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { deleteDatasetPrompt } from "./delete-dataset";

describe("deleteDatasetPrompt", () => {
  it("names the dataset and its rows", () => {
    expect(deleteDatasetPrompt({ name: "Tickets" }, 1)).toBe(
      "Delete “Tickets” and its 1 row?",
    );
    expect(deleteDatasetPrompt({ name: "Tickets" }, 3)).toBe(
      "Delete “Tickets” and its 3 rows?",
    );
  });

  it("warns that a synced dataset goes from every project member's machine", () => {
    expect(deleteDatasetPrompt({ name: "Tickets", synced: true }, 2)).toBe(
      "Delete “Tickets” and its 2 rows?\n\nIt's synced with Evalution Cloud, so it will also be deleted from the cloud and from every project member's machine.",
    );
  });
});
