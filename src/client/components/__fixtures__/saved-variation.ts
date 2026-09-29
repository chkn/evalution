// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { NormalizedPrompt } from "../../../shared/types";

/** A saved variation's id, as the saved-variation tests' mocked read serves it. */
export const SAVED_VARIATION_ID = "var_saved";

/** The prompt the mocked `GET …?variation=var_saved` returns: a named variation. */
export const savedVariationPrompt: NormalizedPrompt = {
  id: "test",
  providerId: "test",
  name: "test",
  functionParameters: [],
  style: "chat",
  modelEditable: true,
  systemEditable: true,
  system: { kind: "primitive", value: "Be brief" },
  messages: [{ role: "user", content: { kind: "primitive", value: "Hi" } }],
  messagesEditable: true,
  modelParameters: [],
  ref: { promptId: "test", variation: SAVED_VARIATION_ID },
  variation: {
    id: SAVED_VARIATION_ID,
    promptId: "test",
    base: "abc1234",
    updates: { style: "chat" },
    wip: false,
    names: ["keeper"],
    createdAt: 0,
    updatedAt: 0,
  },
  atHead: true,
};
