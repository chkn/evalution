// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * A word-level diff for showing how two versions of a long field — a system
 * prompt, say — differ, rather than making someone spot it by eye.
 */

/** A run of text that is in both, only the old, or only the new. */
export interface DiffSegment {
  type: "same" | "del" | "add";
  text: string;
}

/** Beyond this many edits the diff isn't worth reading: show a replacement. */
const MAX_EDITS = 2000;

/** Words and the whitespace between them, as separate tokens. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter(t => t !== "");
}

/**
 * The segments that turn `a` into `b`, word by word. Adjacent segments of a
 * kind are joined. Common prefixes and suffixes are split off first, so the
 * usual case — a few words changed in a long prompt — costs little.
 */
export function diffWords(a: string, b: string): DiffSegment[] {
  const x = tokenize(a);
  const y = tokenize(b);
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }

  const ops: DiffSegment[] = [];
  const push = (type: DiffSegment["type"], text: string) => {
    if (!text) return;
    const last = ops.at(-1);
    if (last?.type === type) last.text += text;
    else ops.push({ type, text });
  };

  push("same", x.slice(0, start).join(""));
  for (const op of myers(x.slice(start, endX), y.slice(start, endY))) {
    push(op.type, op.text);
  }
  push("same", x.slice(endX).join(""));
  return ops;
}

/** Myers' O(ND) shortest edit script over tokens. */
function myers(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [
      ...(n ? [{ type: "del" as const, text: a.join("") }] : []),
      ...(m ? [{ type: "add" as const, text: b.join("") }] : []),
    ];
  }
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let xi =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let yi = xi - k;
      while (xi < n && yi < m && a[xi] === b[yi]) {
        xi++;
        yi++;
      }
      next[offset + k] = xi;
      if (xi >= n && yi >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  if (!found) {
    return [
      { type: "del", text: a.join("") },
      { type: "add", text: b.join("") },
    ];
  }

  // Walk the trace back from the end to recover the script.
  const out: DiffSegment[] = [];
  let xi = n;
  let yi = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = xi - yi;
    const prevK =
      k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])
        ? k + 1
        : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (xi > prevX && yi > prevY) {
      out.push({ type: "same", text: a[--xi] });
      yi--;
    }
    if (d === 0) break;
    if (xi === prevX) out.push({ type: "add", text: b[--yi] });
    else out.push({ type: "del", text: a[--xi] });
  }
  return out.reverse();
}
