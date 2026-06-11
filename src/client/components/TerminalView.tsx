// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  SETUP_STEP_DONE_EVENT,
  type SetupStepDoneDetail,
} from '../../shared/setup-task';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewProps {
  /** Id of the setup task this terminal's step belongs to. */
  taskId: string;
  /** Id of the step whose command this terminal runs. */
  stepId: string;
  /** The command, shown queued up before the user runs it. Display only. */
  command: string;
}

/** Messages streamed down from the server's PTY (see `server/terminal.ts`). */
type ServerMessage =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

/** Builds the terminal WebSocket URL, honouring the page's host and TLS. */
function terminalSocketUrl(taskId: string, stepId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ taskId, stepId });
  return `${proto}://${location.host}/api/terminal?${params}`;
}

/**
 * Interactive terminal pane. Renders the queued command and waits for the user
 * to press Return; on Return it asks the server to spawn the command in a PTY,
 * streams the output into an xterm view, and forwards the user's keystrokes
 * back so interactive prompts work. On a clean exit it broadcasts
 * {@link SETUP_STEP_DONE_EVENT} so the setup list can mark the step complete.
 */
export function TerminalView({ taskId, stepId, command }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const css = getComputedStyle(container);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: css.getPropertyValue('--panel-bg').trim() || '#1e1e1e',
        foreground: css.getPropertyValue('--panel-text').trim() || '#eaeaea',
        cursor: css.getPropertyValue('--panel-text').trim() || '#eaeaea',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const safeFit = () => { try { fit.fit(); } catch { /* container detached/unsized */ } };
    safeFit();
    // The container may not have its final layout on the first synchronous
    // pass; refit after a frame so the initial dimensions are accurate.
    requestAnimationFrame(safeFit);
    term.focus();

    let started = false;
    let pendingStart = false;
    let exited = false;

    const ws = new WebSocket(terminalSocketUrl(taskId, stepId));

    // Hint first, then the command on its own line with the cursor parked at
    // the end of it (no trailing newline) so it reads like a real prompt.
    term.write('\x1b[2m# Press Return to run, or close this tab to skip.\x1b[0m\r\n');
    term.write(`\x1b[1m$ ${command}\x1b[0m`);

    const startPayload = () => {
      // Refit right before launch so the PTY is spawned at the size the user is
      // actually looking at — npm and friends suppress their progress UI when
      // the reported terminal is too small.
      safeFit();
      return JSON.stringify({ type: 'start', cols: term.cols, rows: term.rows });
    };

    const sendStart = () => {
      if (started) return;
      started = true;
      if (ws.readyState === WebSocket.OPEN) ws.send(startPayload());
      else pendingStart = true;
    };

    ws.onopen = () => {
      if (pendingStart) ws.send(startPayload());
    };

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      switch (msg.type) {
        case 'data':
          term.write(msg.data);
          break;
        case 'error':
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          break;
        case 'exit':
          exited = true;
          term.write(
            msg.code === 0
              ? `\r\n\x1b[32m✓ Completed successfully.\x1b[0m\r\n`
              : `\r\n\x1b[31m✗ Exited with code ${msg.code}.\x1b[0m\r\n`,
          );
          if (msg.code === 0) {
            window.dispatchEvent(
              new CustomEvent<SetupStepDoneDetail>(SETUP_STEP_DONE_EVENT, { detail: { taskId, stepId } }),
            );
          }
          break;
      }
    };

    ws.onclose = () => {
      if (!exited) term.write('\r\n\x1b[2m(disconnected)\x1b[0m\r\n');
    };

    const onData = term.onData((data) => {
      if (!started) {
        // Before the command runs, only Return launches it; ignore other keys.
        if (data === '\r' || data === '\n') {
          term.write('\r\n'); // drop to a fresh line before the command's output
          sendStart();
        }
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const onResize = term.onResize(({ cols, rows }) => {
      if (started && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const observer = new ResizeObserver(safeFit);
    observer.observe(container);

    return () => {
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      ws.close();
      term.dispose();
    };
  }, [taskId, stepId, command]);

  return <div className="terminal-view" ref={containerRef} />;
}
