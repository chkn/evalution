// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

export function personalizedReview(username: string, codeSnippet: string) {
  return {
    model: "anthropic/claude-sonnet-4-20250514",
    system: "You are a code reviewer for " + username,
    messages: [{ role: "user", content: "Review this code: " + codeSnippet }],
  };
}
