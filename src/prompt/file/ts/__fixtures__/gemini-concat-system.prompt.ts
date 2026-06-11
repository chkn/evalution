// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { GoogleGenAI } from "@google/genai";

export function oracleMessage(): Parameters<
  typeof GoogleGenAI.prototype.interactions.create
>[0] {
  return {
    model: "gemini-3.1-pro-preview",
    system_instruction:
      "You are a magic oracle for kids, a wise and playful entity that tries to answer any question " +
      "in a way that is age appropriate and easy for them to understand. Use simple language, fun examples, " +
      "and a friendly tone to make your answers engaging and informative.",
    input: [],
  };
}
