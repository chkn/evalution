// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TraceGroup,
  TraceGroupQuery,
  TraceQuery,
  TraceSummary,
} from "../../shared/types";
import { getTraceGroups, getTraces } from "../api";
import {
  DEFAULT_TRACE_LIST_VIEW,
  parseTraceGrouping,
  type TraceListGrouping,
  type TraceListView,
} from "../components/trace-list-view";

/** Where a {@link TraceListing} reads traces from: the server, unless a test says otherwise. */
export interface TraceSource {
  /** The traces `query` matches. */
  list(query: TraceQuery): Promise<TraceSummary[]>;
  /** Those traces as the groups of a column. */
  groups(query: TraceGroupQuery): Promise<TraceGroup[]>;
}

const SERVER: TraceSource = { list: getTraces, groups: getTraceGroups };

/** What the trace list shows, and the means to change it. */
export interface TraceListing {
  /**
   * The traces the view's search and filters match, newest first. Not kept
   * up to date while the view groups by a column, which fetches
   * {@link groups} instead.
   */
  traces: TraceSummary[];
  /** The matching traces as groups, while the view groups by a column. */
  groups: TraceGroup[] | undefined;
  /** The traces of each group that's been expanded, by its key. */
  members: Record<string, TraceSummary[] | undefined>;
  /** Fetches a group's traces into {@link members}, unless it already is. */
  loadGroup: (group: TraceGroup) => void;
  /**
   * The values `column` takes among the traces the search and the other
   * columns' filters match, as groups: what a filter on it can choose from.
   */
  facets: (
    column: TraceGroupQuery["groupBy"]["column"],
  ) => Promise<TraceGroup[]>;
  view: TraceListView;
  setView: (view: TraceListView) => void;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const GROUPING_STORAGE_KEY = "trace-list-grouping";

function loadGrouping(): TraceListGrouping {
  try {
    const stored = localStorage.getItem(GROUPING_STORAGE_KEY);
    if (stored) return parseTraceGrouping(JSON.parse(stored));
  } catch {
    /* ignore */
  }
  return DEFAULT_TRACE_LIST_VIEW.grouping;
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const newestFirst = (traces: TraceSummary[]) =>
  [...traces].sort((a, b) => b.startTime - a.startTime);

/**
 * Fetches the traces every trace provider knows that the list's view asks
 * for (its search and filters, as groups when it groups by a column), again
 * whenever the view changes or {@link TraceListing.refetch} is called for a
 * server-sent change event. The grouping is remembered across reloads.
 */
export function useTraces(source: TraceSource = SERVER): TraceListing {
  const [view, setViewState] = useState<TraceListView>(() => ({
    ...DEFAULT_TRACE_LIST_VIEW,
    grouping: loadGrouping(),
  }));
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [groups, setGroups] = useState<TraceGroup[] | undefined>();
  const [members, setMembers] = useState<
    Record<string, TraceSummary[] | undefined>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // What the fetches below read, so that `refetch` stays the same function
  // however the view changes: the app calls it from long-lived listeners.
  const viewRef = useRef(view);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const membersRef = useRef(members);
  membersRef.current = members;
  /** The groups whose traces are being fetched. */
  const loadingGroups = useRef(new Set<string>());
  /** Counts the listings asked for, so an answer that's been overtaken is dropped. */
  const asked = useRef(0);

  const refetch = useCallback(async () => {
    const id = ++asked.current;
    const { search, filters, grouping } = viewRef.current;
    const current = sourceRef.current;
    try {
      if (typeof grouping === "string") {
        const list = newestFirst(await current.list({ search, filters }));
        if (id !== asked.current) return;
        setTraces(list);
        setGroups(undefined);
        setMembers({});
      } else {
        const found = await current.groups({
          search,
          filters,
          groupBy: grouping,
          timeZone: timeZone(),
        });
        // The groups already expanded are listed afresh along with them.
        const open = found.filter(group => membersRef.current[group.key]);
        const lists = await Promise.all(
          open.map(group =>
            current.list({ search, filters: [...filters, group.filter] }),
          ),
        );
        if (id !== asked.current) return;
        setGroups(found);
        setMembers(
          Object.fromEntries(
            open.map((group, i) => [group.key, newestFirst(lists[i]!)]),
          ),
        );
      }
      setError(null);
    } catch (err: any) {
      if (id === asked.current) setError(err.message);
    } finally {
      if (id === asked.current) setLoading(false);
    }
  }, []);

  const setView = useCallback(
    (next: TraceListView) => {
      viewRef.current = next;
      // Another view's groups aren't this one's, even under the same key.
      membersRef.current = {};
      loadingGroups.current.clear();
      setMembers({});
      setViewState(next);
      try {
        localStorage.setItem(
          GROUPING_STORAGE_KEY,
          JSON.stringify(next.grouping),
        );
      } catch {
        /* ignore */
      }
      void refetch();
    },
    [refetch],
  );

  const loadGroup = useCallback((group: TraceGroup) => {
    const { key } = group;
    if (membersRef.current[key] || loadingGroups.current.has(key)) return;
    loadingGroups.current.add(key);
    const from = viewRef.current;
    sourceRef.current
      .list({ search: from.search, filters: [...from.filters, group.filter] })
      .then(list => {
        if (viewRef.current !== from) return;
        setMembers(prev => ({ ...prev, [key]: newestFirst(list) }));
      })
      .catch(() => {
        // Left unloaded: the list asks again the next time it renders the
        // group expanded.
      })
      .finally(() => {
        if (viewRef.current === from) loadingGroups.current.delete(key);
      });
  }, []);

  const facets = useCallback<TraceListing["facets"]>(column => {
    const { search, filters } = viewRef.current;
    return sourceRef.current.groups({
      search,
      filters: filters.filter(filter => filter.column !== column),
      groupBy: { column },
      timeZone: timeZone(),
    });
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    traces,
    groups,
    members,
    loadGroup,
    facets,
    view,
    setView,
    loading,
    error,
    refetch,
  };
}
