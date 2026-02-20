import { useState, useEffect } from 'react';
import type { ParsedPrompt } from '../../shared/types';

export function usePrompts() {
  const [prompts, setPrompts] = useState<ParsedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/prompts');

      if (!response.ok) {
        throw new Error('Failed to fetch prompts');
      }

      const data = await response.json();
      setPrompts(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrompts();
  }, []);

  return {
    prompts,
    loading,
    error,
    refetch: fetchPrompts,
  };
}
