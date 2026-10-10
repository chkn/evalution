// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useRef, useState } from "react";
import type { ResourceInfo } from "../../shared/types";
import {
  adoptCatalogPick,
  type InstanceSelections,
} from "./run-resources-state";

/** What {@link useRunInstances} returns. */
export interface RunInstances {
  /** The run's instances, as of this render. */
  instances: InstanceSelections;
  /** Replaces the instances, or derives them from the latest. */
  setInstances: (
    next:
      | InstanceSelections
      | ((latest: InstanceSelections) => InstanceSelections),
  ) => void;
  /**
   * `SourceContext.adopt`: adds an instance for a catalog pick (or reuses a
   * server-scoped one) and returns the reference to bind.
   */
  adopt: (uri: string) => string;
}

/**
 * The run's instances as host state. Updates apply to the latest value
 * synchronously rather than to the one a render saw, so a catalog pick —
 * which adds an instance and binds a slot (or another instance's argument)
 * in one gesture — never has one half overwrite the other.
 *
 * @param resourcesByUri - The catalog, for {@link adoptCatalogPick}.
 * @param onSet - Called with every new value, for the host to persist.
 */
export function useRunInstances(
  initial: InstanceSelections | (() => InstanceSelections),
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
  onSet?: (next: InstanceSelections) => void,
): RunInstances {
  const [instances, setState] = useState(initial);
  const latest = useRef(instances);
  const byUri = useRef(resourcesByUri);
  byUri.current = resourcesByUri;
  const onSetRef = useRef(onSet);
  onSetRef.current = onSet;

  const setInstances = useCallback<RunInstances["setInstances"]>(next => {
    const value = typeof next === "function" ? next(latest.current) : next;
    if (value === latest.current) return;
    latest.current = value;
    setState(value);
    onSetRef.current?.(value);
  }, []);

  const adopt = useCallback(
    (uri: string) => {
      const picked = adoptCatalogPick(latest.current, uri, byUri.current);
      setInstances(picked.instances);
      return picked.uri;
    },
    [setInstances],
  );

  return { instances, setInstances, adopt };
}
