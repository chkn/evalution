// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado
// Copyright (c) 2026 Invisible Tools, Inc. (dba Raindrop)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Collapsible, syntax-colored JSON viewer. Ported from Workshop's
 * `JsonView.tsx` — inline styles → CSS-token classes (`.json-*`, defined in
 * `styles.css`) — see `specs/trace-workshopping.md` §D.
 */

import { useCallback, useMemo, useState } from "react";

const INDENT = 16;

function Arrow({ open }: { open: boolean }) {
  return (
    <svg
      className={`json-arrow${open ? " json-arrow-open" : ""}`}
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ExpandableString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const display = expanded ? value : `${value.slice(0, 300)}…`;
  return (
    <>
      <span className="json-string">&quot;{display}&quot;</span>
      <button
        type="button"
        className="json-expand-toggle"
        onClick={e => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
      >
        {expanded ? "less" : "more"}
      </button>
    </>
  );
}

interface NodeProps {
  keyName?: string | number;
  value: unknown;
  depth: number;
  maxExpand: number;
  isLast: boolean;
}

function JsonNode({ keyName, value, depth, maxExpand, isLast }: NodeProps) {
  const isObj =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isArr = Array.isArray(value);
  const expandable = isObj || isArr;
  const [open, setOpen] = useState(depth < maxExpand);
  const trail = isLast ? "" : ",";

  const keyEl =
    keyName !== undefined ? (
      <>
        <span
          className={`json-key${typeof keyName === "number" ? " json-key-index" : ""}`}
        >
          {keyName}
        </span>
        <span className="json-brace">: </span>
      </>
    ) : null;

  if (!expandable) {
    let className = "json-value";
    let display: React.ReactNode;

    if (value === null) {
      className += " json-null";
      display = "null";
    } else if (value === undefined) {
      className += " json-null";
      display = "undefined";
    } else if (typeof value === "boolean") {
      className += " json-boolean";
      display = String(value);
    } else if (typeof value === "number") {
      className += " json-number";
      display = String(value);
    } else if (typeof value === "string") {
      className += " json-string";
      display =
        value.length > 300 ? (
          <ExpandableString value={value} />
        ) : (
          <>&quot;{value}&quot;</>
        );
    } else {
      display = String(value);
    }

    return (
      <div className="json-row" style={{ paddingLeft: depth * INDENT }}>
        {keyEl}
        <span className={className}>{display}</span>
        <span className="json-comma">{trail}</span>
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArr
    ? value.map((v, i): [number, unknown] => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const br = isArr ? ["[", "]"] : ["{", "}"];
  const n = entries.length;

  if (n === 0) {
    return (
      <div className="json-row" style={{ paddingLeft: depth * INDENT }}>
        {keyEl}
        <span className="json-brace">
          {br[0]}
          {br[1]}
        </span>
        <span className="json-comma">{trail}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <div
        className="json-row json-row-collapsed"
        style={{ paddingLeft: depth * INDENT }}
        onClick={e => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Arrow open={false} />
        {keyEl}
        <span className="json-brace">{br[0]}</span>
        <span className="json-count">
          {n} {isArr ? (n === 1 ? "item" : "items") : n === 1 ? "key" : "keys"}
        </span>
        <span className="json-brace">{br[1]}</span>
        <span className="json-comma">{trail}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        className="json-row json-row-collapsed"
        style={{ paddingLeft: depth * INDENT }}
        onClick={e => {
          e.stopPropagation();
          setOpen(false);
        }}
      >
        <Arrow open />
        {keyEl}
        <span className="json-brace">{br[0]}</span>
      </div>
      <div className="json-children" style={{ marginLeft: depth * INDENT + 5 }}>
        {entries.map(([k, v], i) => (
          <JsonNode
            key={typeof k === "number" ? i : k}
            keyName={k}
            value={v}
            depth={depth + 1}
            maxExpand={maxExpand}
            isLast={i === n - 1}
          />
        ))}
      </div>
      <div className="json-row" style={{ paddingLeft: depth * INDENT + 10 }}>
        <span className="json-brace">{br[1]}</span>
        <span className="json-comma">{trail}</span>
      </div>
    </div>
  );
}

/**
 * Renders `data` as a collapsible JSON tree. A stringified JSON value is
 * parsed first; nested stringified JSON (a value that is itself a `{…}`/`[…]`
 * string) is deep-parsed too, so a doubly-encoded payload still renders as a
 * tree rather than a quoted blob.
 */
export function JsonView({
  data,
  maxExpand = 3,
}: {
  data: unknown;
  maxExpand?: number;
}) {
  const parsed = useMemo(() => {
    if (typeof data === "string") {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
    return data;
  }, [data]);

  const deepParse = useCallback((v: unknown): unknown => {
    if (typeof v === "string") {
      const s = v.trim();
      if (
        (s[0] === "{" && s[s.length - 1] === "}") ||
        (s[0] === "[" && s[s.length - 1] === "]")
      ) {
        try {
          const p = JSON.parse(s);
          if (p && typeof p === "object") return deepParse(p);
        } catch {
          // not JSON after all — keep the raw string
        }
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(deepParse);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>))
        o[k] = deepParse(val);
      return o;
    }
    return v;
  }, []);

  const normalized = useMemo(() => deepParse(parsed), [parsed, deepParse]);

  if (parsed !== null && typeof parsed === "object") {
    return (
      <div className="json-view" onClick={e => e.stopPropagation()}>
        <JsonNode value={normalized} depth={0} maxExpand={maxExpand} isLast />
      </div>
    );
  }

  return <pre className="json-view json-view-plain">{String(parsed)}</pre>;
}
