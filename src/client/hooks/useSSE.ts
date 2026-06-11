// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect } from 'react';
import type { SSEData } from '../../shared/types.ts';

export function useSSE(onMessage: (data: SSEData) => void, onOpen?: () => void) {
  useEffect(() => {
    const eventSource = new EventSource('/api/events');

    // Fires on the initial connection and on every reconnect — including after
    // the server restarts itself once a config file appears, which is how the
    // client learns to refetch state that changed across the restart.
    eventSource.onopen = () => onOpen?.();

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
    };

    return () => {
      eventSource.close();
    };
  }, [onMessage, onOpen]);
}
