// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { Theme } from "@glideapps/glide-data-grid";
import { useEffect, useState } from "react";
import { subscribeAppliedTheme } from "../theme";

/** The monospace family the grid's header draws types in. */
export const GRID_MONO_FONT = '"Geist Mono", ui-monospace, monospace';

/**
 * The Glide Data Grid theme, read from the app's CSS variables. The grid
 * draws on a canvas, which stylesheets can't reach, so the colors are copied
 * over — and copied again whenever the color scheme flips.
 */
function readTheme(): Partial<Theme> {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const fontFamily = getComputedStyle(document.body).fontFamily;
  return {
    accentColor: v("--link"),
    accentLight: v("--accent-faint"),
    textDark: v("--trace-text"),
    textMedium: v("--trace-text-dim"),
    textLight: v("--trace-text-dim"),
    textHeader: v("--trace-text"),
    textGroupHeader: v("--trace-text-dim"),
    // What a header sprite is drawn in — here, the group disclosure triangle.
    fgIconHeader: v("--trace-text-dim"),
    textBubble: v("--pill-text"),
    bgCell: v("--trace-bg"),
    bgCellMedium: v("--trace-row-alt"),
    bgHeader: v("--trace-bg"),
    bgHeaderHasFocus: v("--trace-row-alt"),
    bgHeaderHovered: v("--trace-row-hover"),
    bgGroupHeader: v("--trace-bg"),
    bgGroupHeaderHovered: v("--trace-row-hover"),
    bgBubble: v("--pill-hover-bg"),
    bgBubbleSelected: v("--pill-hover-bg"),
    borderColor: v("--trace-border"),
    horizontalBorderColor: v("--trace-border"),
    linkColor: v("--link"),
    fontFamily,
    baseFontStyle: "12.5px",
    headerFontStyle: "600 11.5px",
    markerFontStyle: "11px",
    editorFontSize: "12.5px",
  };
}

/** {@link readTheme}, kept current across light/dark switches. */
export function useGridTheme(): Partial<Theme> {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => subscribeAppliedTheme(() => setTheme(readTheme())), []);
  return theme;
}
