import { useState, useEffect, useRef } from 'react';

interface UseResizableOptions {
  initial: number;
  min?: number;
  max?: number;
  direction?: 'horizontal' | 'vertical';
  storageKey?: string;
}

export function useResizable({ initial, min = 0, max = Infinity, direction = 'horizontal', storageKey }: UseResizableOptions) {
  const [size, setSize] = useState(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return Math.max(min, Math.min(max, Number(stored)));
    }
    return initial;
  });
  const resizing = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const pos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = pos - startPos.current;
      const next = Math.max(min, Math.min(max, startSize.current + delta));
      setSize(next);
      if (storageKey) localStorage.setItem(storageKey, String(next));
    };
    const onMouseUp = () => { resizing.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [direction, min, max]);

  const onMouseDown = (e: React.MouseEvent) => {
    resizing.current = true;
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize.current = size;
    e.preventDefault();
  };

  return { size, onMouseDown };
}
