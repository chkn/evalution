// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { TraceQueryColumn } from "../../shared/types";
import {
  AnnotationsIcon,
  CalendarIcon,
  CostIcon,
  EnvironmentIcon,
  EvalsIcon,
  ModelIcon,
  SpansIcon,
  StopwatchIcon,
  TokensIcon,
  VariationIcon,
  VersionIcon,
} from "./trace/icons.tsx";

/** The icon that marks a trace column, if it has one. */
export function traceColumnIcon(key: TraceQueryColumn) {
  switch (key) {
    case "startTime":
      return <CalendarIcon />;
    case "spanCount":
      return <SpansIcon />;
    case "duration":
      return <StopwatchIcon />;
    case "totalTokens":
      return <TokensIcon />;
    case "model":
      return <ModelIcon />;
    case "environment":
      return <EnvironmentIcon />;
    case "cost":
      return <CostIcon />;
    case "annotations":
      return <AnnotationsIcon />;
    case "checks":
      return <EvalsIcon />;
    case "version":
      return <VersionIcon />;
    case "variation":
      return <VariationIcon />;
    default:
      // Name and status have no icon.
      return null;
  }
}
