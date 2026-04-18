import { useLayoutEffect, useRef } from 'react';
import type { NormalizedPrompt } from '../../shared/types';
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
  onExecuted?: (traceProviderId: string, traceId: string, label: string) => void;
}

// Minimum container width at which a 2-column layout is worth considering.
const MULTICOL_MIN_WIDTH = 660;

/**
 * Renders the playground editor + execution panels, switching to a CSS
 * multi-column layout only when the content would overflow a single column
 * at the container's current width.
 */
function PlaygroundContent({ prompt, onUpdate, onDirtyChange, onExecuted }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    let measuring = false;

    const measure = () => {
      raf = 0;
      if (measuring) return;
      measuring = true;
      try {
        // Measure natural height in single-column mode.
        const had = el.classList.contains('pg-content--multicol');
        if (had) el.classList.remove('pg-content--multicol');
        const overflows = el.scrollHeight > el.clientHeight + 1;
        const wide = el.clientWidth >= MULTICOL_MIN_WIDTH;
        el.classList.toggle('pg-content--multicol', wide && overflows);
      } finally {
        // Defer releasing the flag so observer callbacks triggered by our
        // own class toggle settle before the next measurement can run.
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
    const mo = new MutationObserver(schedule);
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
