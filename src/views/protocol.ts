// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The messages a view's frame and its host exchange by `postMessage`: a
 * generic envelope, whose payloads each surface narrows. Imported by both
 * sides. See `specs/trace-visualizers.md` §C.1.
 */

/**
 * The protocol's version. A host that gets a `ready` with a version it
 * doesn't speak asks for the view to be rebuilt rather than guessing.
 */
export const PROTOCOL = 1;

/**
 * The host's theme, as CSS custom properties the runtime sets on the frame's
 * `:root` — so a view matches light and dark mode whatever it's written in.
 */
export interface ViewTheme {
  /** The resolved color scheme. */
  mode: "light" | "dark";
  /** Custom property name (`--ev-bg`) → value. */
  tokens: Record<string, string>;
}

/**
 * Host → frame. Every message that changes what the view knows carries a
 * host-assigned `rev`, which an effectful action names so a stale one can be
 * refused.
 */
export type HostMessage<S = unknown, E = unknown, C = unknown> =
  /** In reply to `ready`: everything the view needs to start. */
  | { type: "init"; subject: S; rev: number; context: C; theme: ViewTheme }
  /** A fresh snapshot of the subject. */
  | { type: "subject"; subject: S; rev: number }
  /** One incremental change, for a surface with `applyEvent`. */
  | { type: "event"; event: E; rev: number }
  /** The host's context changed. */
  | { type: "context"; context: C; rev: number }
  /** The host's theme changed. */
  | { type: "theme"; theme: ViewTheme }
  /** An action was refused. */
  | { type: "rejected"; name: string; reason: string };

/** Frame → host. Untrusted: the host checks each one. */
export type FrameMessage =
  /**
   * The runtime has loaded the view, or found it isn't one for this
   * surface (`error`).
   */
  | {
      type: "ready";
      protocol: number;
      surface?: string;
      label?: string;
      error?: string;
    }
  /** Whether the view applies; after `init`, and whenever it changes. */
  | { type: "applies"; value: boolean }
  /** The view asked for one of its surface's actions, as of `rev`. */
  | { type: "action"; name: string; args: unknown; rev: number }
  /** The view asked for a URL to be opened. */
  | { type: "openUrl"; url: string }
  /** `applies`, `mount`, or `update` threw, or the view reported an error. */
  | { type: "error"; message: string; during?: "applies" | "render" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `data` as a {@link FrameMessage}, or `undefined` if it isn't one — what
 * the host makes of whatever a frame posts.
 */
export function parseFrameMessage(data: unknown): FrameMessage | undefined {
  if (!isRecord(data)) return undefined;
  const optionalString = (key: string) =>
    data[key] === undefined || typeof data[key] === "string";
  switch (data.type) {
    case "ready":
      return typeof data.protocol === "number" &&
        optionalString("surface") &&
        optionalString("label") &&
        optionalString("error")
        ? (data as FrameMessage)
        : undefined;
    case "applies":
      return typeof data.value === "boolean"
        ? { type: "applies", value: data.value }
        : undefined;
    case "action":
      return typeof data.name === "string" && typeof data.rev === "number"
        ? { type: "action", name: data.name, args: data.args, rev: data.rev }
        : undefined;
    case "openUrl":
      return typeof data.url === "string"
        ? { type: "openUrl", url: data.url }
        : undefined;
    case "error":
      return typeof data.message === "string"
        ? {
            type: "error",
            message: data.message,
            ...(data.during === "applies" || data.during === "render"
              ? { during: data.during }
              : {}),
          }
        : undefined;
    default:
      return undefined;
  }
}

/** `data` as a {@link HostMessage}, or `undefined` if it isn't one. */
export function parseHostMessage(data: unknown): HostMessage | undefined {
  if (!isRecord(data) || typeof data.type !== "string") return undefined;
  switch (data.type) {
    case "init":
    case "subject":
    case "event":
    case "context":
      return typeof data.rev === "number" ? (data as HostMessage) : undefined;
    case "theme":
      return isRecord(data.theme) ? (data as HostMessage) : undefined;
    case "rejected":
      return typeof data.reason === "string"
        ? (data as HostMessage)
        : undefined;
    default:
      return undefined;
  }
}
