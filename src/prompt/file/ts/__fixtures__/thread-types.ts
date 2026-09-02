// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/** Supporting types for `cross-file-param.prompt.ts`. */
export interface ThreadMessage {
  /** The portion of the message that pertains to this thread. */
  excerpt: string;
  body: string;
  sentAt: number;
}
