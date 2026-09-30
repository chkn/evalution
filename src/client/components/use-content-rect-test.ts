// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Whether the observed element's content box passes `test`, kept current as
 * it resizes and as `test` changes — `initial` until it's measured. Only
 * re-renders when the answer flips, not on every pixel of a resize.
 *
 * `test` should be stable (`useCallback`) unless what it tests against
 * changes: a new `test` is re-run against the last size seen.
 *
 * Uses a callback ref rather than `useRef` + `useEffect([])`: a view may
 * render a loading placeholder (without the element this attaches to) until
 * its data arrives, so the element mounts on a later render, not the first
 * one — an effect keyed on `ref.current` would miss that.
 */
export function useContentRectTest(
  test: (rect: DOMRectReadOnly) => boolean,
  initial = false,
) {
  const [matches, setMatches] = useState(initial);
  const testRef = useRef(test);
  const rectRef = useRef<DOMRectReadOnly | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    testRef.current = test;
    if (rectRef.current) setMatches(test(rectRef.current));
  }, [test]);

  const ref = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    rectRef.current = null;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      rectRef.current = entry.contentRect;
      setMatches(testRef.current(entry.contentRect));
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return { ref, matches };
}
