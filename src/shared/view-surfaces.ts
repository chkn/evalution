// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The surfaces sandboxed views can appear on, by name — what the server needs
 * to know of them to discover views, without the browser-side descriptors in
 * `src/views/surfaces/`. See `specs/trace-visualizers.md` §A.1.
 */

/** Where a project's views live; each surface has a directory inside it. */
export const VIEWS_DIR = ".evalution/views";

/** Every surface's name, which is also its directory under {@link VIEWS_DIR}. */
export const SURFACE_NAMES = ["traces", "datasets"] as const;

/** A surface's name. */
export type SurfaceName = (typeof SURFACE_NAMES)[number];

/** Whether `name` names a known surface. */
export function isSurfaceName(name: string): name is SurfaceName {
  return (SURFACE_NAMES as readonly string[]).includes(name);
}

/**
 * The route every view's frame document is served from. The host page's
 * `frame-src` names exactly this path, so a frame can't navigate anywhere
 * else. See `specs/trace-visualizers.md` §B.3.
 */
export const VIEW_FRAME_PATH = "/api/views/frame";

/** The URL of a view's frame document. */
export function viewFrameUrl(uri: string, moduleVersion: string): string {
  return `${VIEW_FRAME_PATH}?uri=${encodeURIComponent(uri)}&v=${encodeURIComponent(moduleVersion)}`;
}
