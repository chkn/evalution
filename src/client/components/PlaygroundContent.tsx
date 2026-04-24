import { useLayoutEffect, useRef } from 'react';
import type { ExecuteResponse, NormalizedPrompt } from '../../shared/types';
import PlaygroundEditor from './PlaygroundEditor';
import PlaygroundExecution from './PlaygroundExecution';

interface Props {
  prompt: NormalizedPrompt;
  onUpdate: (updated: NormalizedPrompt) => void;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Invoked after a successful execution with the trace that was registered
   * for it. Lets the surrounding app open a trace tab in a split pane.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
}

// Minimum container width at which a 2-column layout is worth considering.
const MULTICOL_MIN_WIDTH = 660;

/**
 * Renders the playground editor + execution panels, switching to a CSS
 * multi-column layout when the pane is wide enough and the content overflows
 * a single column.
 *
 * The column break point is computed in JS:
 *   1. Greedily fill column 1 with panels until we've exceeded the
 *      available height.
 *   2. Remaining panels go into column 2 (which may itself overflow — the
 *      container grows and both columns scroll together via pg-content's
 *      overflow-y: auto).
 *   3. If column 2 hasn't overflowed AND the last panel in column 1 would fit
 *      at the start of column 2 without overflowing it, move it there — this
 *      avoids leaving column 1 mostly empty when a tall panel (e.g. Messages)
 *      is the first one that doesn't fit.
 */
function PlaygroundContent({ prompt, onUpdate, onDirtyChange, onExecuted }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    let measuring = false;
    // Declared before `measure` so it can be disconnected inside the function,
    // preventing our own DOM changes from triggering a re-measurement loop.
    let mo: MutationObserver | undefined;

    const measure = () => {
      raf = 0;
      if (measuring) return;
      measuring = true;
      mo?.disconnect();
      try {
        // Reset to single-column so panel positions are accurate.
        el.classList.remove('pg-content--multicol');
        el.querySelectorAll<HTMLElement>('.pg-panel').forEach(p => {
          p.style.maxWidth = '';
          p.style.gridColumn = '';
          p.style.gridRow = '';
        });

        if (el.clientWidth < MULTICOL_MIN_WIDTH) return;
        if (el.scrollHeight <= el.clientHeight + 1) return;

        const cs = getComputedStyle(el);
        const availH = el.clientHeight
          - parseFloat(cs.paddingTop)
          - parseFloat(cs.paddingBottom);

        const panels = Array.from(el.querySelectorAll<HTMLElement>('.pg-panel'));
        if (panels.length < 2) return;

        // Measure panel heights at the width they'll actually occupy in the
        // two-column layout. Text-wrapping panels (e.g. Messages) are taller
        // at half-width; measuring at full-width gives wrong slot heights.
        const colW = Math.floor(
          (el.clientWidth
          - parseFloat(cs.paddingLeft)
          - parseFloat(cs.paddingRight)
          - 12) / 2); // 12px is the column gap
        panels.forEach(p => { p.style.maxWidth = `${colW}px`; });

        // Slot height = vertical space each panel occupies including the gap to
        // the next panel. The last panel uses its own height (no trailing gap).
        const rects = panels.map(p => p.getBoundingClientRect());
        const slotH = rects.map((r, i) =>
          i < rects.length - 1 ? rects[i + 1].top - r.top : r.height
        );

        panels.forEach(p => { p.style.maxWidth = ''; });

        // Step 1: greedily fill column 1.
        let col1H = 0;
        let breakIdx = panels.length;
        for (let i = 0; i < panels.length; i++) {
          if (col1H > availH) { breakIdx = i; break; }
          col1H += slotH[i];
        }
        // Ensure column 1 always has at least one panel.
        if (breakIdx === 0) breakIdx = 1;
        // All panels fit in column 1 — no split needed.
        if (breakIdx === panels.length) return;

        // Step 2: column 2 gets the rest (may overflow; that's fine).
        const col2H = slotH.slice(breakIdx).reduce((s, h) => s + h, 0);

        // Step 3: if column 2 hasn't overflowed AND the last col-1 panel fits
        // at the start of col-2 without overflowing it, move it there.
        if (col2H <= availH && col2H + slotH[breakIdx - 1] <= availH && breakIdx > 1) {
          breakIdx--;
        }

        // Assign each panel to its grid column and row (1px row units).
        let col1Row = 1, col2Row = 1;
        panels.forEach((panel, i) => {
          const span = Math.ceil(rects[i].height) + 12; // height + margin-bottom gap
          const col = i < breakIdx ? 1 : 2;
          const row = col === 1 ? col1Row : col2Row;
          panel.style.gridColumn = String(col);
          panel.style.gridRow = `${row} / ${row + span}`;
          if (col === 1) col1Row += span;
          else col2Row += span;
        });
        el.classList.add('pg-content--multicol');
      } finally {
        mo?.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
        requestAnimationFrame(() => { measuring = false; });
      }
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    measure();

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <div className="pg-content" ref={ref}>
      <PlaygroundEditor prompt={prompt} onUpdate={onUpdate} onDirtyChange={onDirtyChange} />
      <PlaygroundExecution prompt={prompt} onExecuted={onExecuted} />
    </div>
  );
}

export default PlaygroundContent;
