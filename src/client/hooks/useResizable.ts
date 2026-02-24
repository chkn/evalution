import { useState, useEffect, useRef } from 'react';

interface UseResizableOptions {
  initial: Record<string, number>;
  min?: number;
  max?: number;
  direction?: 'horizontal' | 'vertical';
  storageKey?: string;
}

export function useResizable({
  initial,
  min = 0,
  max = Infinity,
  direction = 'horizontal',
  storageKey,
}: UseResizableOptions) {
  const [sizes, setSizesState] = useState<Record<string, number>>(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      } catch { /* ignore */ }
    }
    return initial;
  });

  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  const persist = (s: Record<string, number>) => {
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(s));
  };

  const setSizes = (s: Record<string, number>) => {
    sizesRef.current = s;
    setSizesState(s);
    persist(s);
  };

  const activeKey = useRef<string | null>(null);
  const startPos  = useRef(0);
  const startSize = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!activeKey.current) return;
      const pos  = direction === 'horizontal' ? e.clientX : e.clientY;
      const next = Math.max(min, Math.min(max, startSize.current + (pos - startPos.current)));
      setSizes({ ...sizesRef.current, [activeKey.current]: next });
    };
    const onMouseUp = () => { activeKey.current = null; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
  }, [direction, min, max]); // eslint-disable-line react-hooks/exhaustive-deps

  const getOnMouseDown = (key: string, size: number) => (e: React.MouseEvent) => {
    activeKey.current = key;
    startPos.current  = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize.current = size;
    e.preventDefault();
  };

  const setSize = (key: string, value: number) =>
    setSizes({ ...sizesRef.current, [key]: value });

  const deleteSize = (key: string) => {
    const { [key]: _, ...rest } = sizesRef.current;
    setSizes(rest);
  };

  return { sizes, getOnMouseDown, setSize, deleteSize };
}
