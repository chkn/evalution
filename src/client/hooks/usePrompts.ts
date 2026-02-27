import { useState, useEffect } from 'react';
import type { ParsedPrompt } from '../../shared/types';
import { getPrompts } from '../api';

export function usePrompts() {
  const [prompts, setPrompts] = useState<ParsedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = async () => {
    try {
      setLoading(true);
      setError(null);
      setPrompts(await getPrompts());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrompts();
  }, []);

  return { prompts, loading, error, refetch: fetchPrompts };
}
