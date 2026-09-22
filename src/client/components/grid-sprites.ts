// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Icons the dataset grid draws in its group headers. Glide rasterizes each
 * from an SVG string (`SpriteManager.drawSprite`) into a 20px box, so these
 * are drawn small and centered inside that box rather than filling it.
 *
 * A group header can only take a *sprite* — its own drawing isn't exposed
 * the way a column header's is — so the disclosure triangle lives here
 * rather than in `DatasetView`'s `drawHeader`.
 */

import type { SpriteMap } from "@glideapps/glide-data-grid";

/**
 * A disclosure chevron in the Mac idiom: two short strokes meeting at a
 * rounded corner, pointing right when collapsed and down when expanded.
 */
function chevron(points: string) {
  return ({ fgColor }: { fgColor: string }) =>
    `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="none" stroke="${fgColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Name of the sprite for a collapsed group. */
export const DISCLOSURE_COLLAPSED = "disclosureCollapsed";
/** Name of the sprite for an expanded group. */
export const DISCLOSURE_EXPANDED = "disclosureExpanded";

/** The grid's `headerIcons`. */
export const GRID_HEADER_ICONS: SpriteMap = {
  [DISCLOSURE_COLLAPSED]: chevron("8.75,6.75 11.9,10 8.75,13.25"),
  [DISCLOSURE_EXPANDED]: chevron("6.75,8.75 10,11.9 13.25,8.75"),
};
