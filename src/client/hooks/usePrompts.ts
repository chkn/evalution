import { useState, useEffect, useCallback } from 'react';
import type { NormalizedPrompt } from '../../shared/types';
import { getPrompts } from '../api';

function samePrompt(a: NormalizedPrompt, b: NormalizedPrompt): boolean {
  return a.id === b.id && a.providerId === b.providerId;
}

export function usePrompts() {
  const [prompts, setPrompts] = useState<NormalizedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setPrompts(await getPrompts());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  const patchPrompt = useCallback((updated: NormalizedPrompt) => {
    setPrompts(prev => {
      let found = false;
      const next = prev.map(prompt => {
        if (!samePrompt(prompt, updated)) return prompt;
        found = true;
        return updated;
      });
      return found ? next : [...prev, updated];
    });
  }, []);

  return { prompts, loading, error, refetch: fetchPrompts, patchPrompt };
}
