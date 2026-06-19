// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import {
  SETUP_STEP_DONE_EVENT,
  type SetupStepDoneDetail,
} from "../../shared/setup-task";
import "@xterm/xterm/css/xterm.css";

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
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

/** Braille frames for the "waiting for the command to start" spinner. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How long each spinner frame is shown, in milliseconds. */
const SPINNER_INTERVAL_MS = 80;

/** Delay between reconnect attempts after the socket drops, in milliseconds. */
const RECONNECT_DELAY_MS = 500;

/**
 * How many times to retry reconnecting before giving up. Spans roughly the
 * server's reconnect grace window (see `GRACE_PERIOD_MS`); past it the session's
 * PTY has been reaped, so there is nothing left to resume.
 */
const MAX_RECONNECT_ATTEMPTS = 20;

/** Builds the terminal WebSocket URL, honouring the page's host and TLS. */
function terminalSocketUrl(
  taskId: string,
  stepId: string,
  sessionId: string,
): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ taskId, stepId, sessionId });
  return `${proto}://${location.host}/api/terminal?${params}`;
}

/**
 * Interactive terminal pane. Renders the queued command and waits for the user
 * to press Return; on Return it asks the server to spawn the command in a PTY,
 * streams the output into an xterm view, and forwards the user's keystrokes
 * back so interactive prompts work. On a clean exit it broadcasts
 * {@link SETUP_STEP_DONE_EVENT} so the setup list can mark the step complete.
 *
 * The connection is identified by a per-mount `sessionId`, so if the socket
 * drops while a command is running — notably when the server restarts itself
 * after a config file appears — the client reconnects, the server re-attaches
 * the still-running PTY, and any output produced during the gap is replayed.
 */
export function TerminalView({ taskId, stepId, command }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const css = getComputedStyle(container);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: css.getPropertyValue("--panel-bg").trim() || "#1e1e1e",
        foreground: css.getPropertyValue("--panel-text").trim() || "#eaeaea",
        cursor: css.getPropertyValue("--panel-text").trim() || "#eaeaea",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container detached/unsized */
      }
    };
    safeFit();
    // The container may not have its final layout on the first synchronous
    // pass; refit after a frame so the initial dimensions are accurate.
    requestAnimationFrame(safeFit);
    term.focus();

    // Stable across reconnects within this mount, so the server can match a
    // reconnecting socket back to the PTY it already spawned for us.
    const sessionId = crypto.randomUUID();

    let started = false;
    let pendingStart = false;
    let exited = false;
    // Set on intentional teardown or a terminal server frame, so a late
    // `onclose` doesn't try to reconnect.
    let stopped = false;
    let everConnected = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // Opened lazily on the first Return, not at mount: there's nothing for the
    // server to do until the command starts, and connecting eagerly would open
    // (and, under React's dev StrictMode double-mount, immediately abort) a
    // socket for no reason.
    let ws: WebSocket | undefined;

    // A spinner is parked at the cursor between pressing Return and the command
    // making its first sound (output) or exiting, so the wait doesn't look dead.
    let spinnerTimer: ReturnType<typeof setInterval> | undefined;

    const startSpinner = () => {
      if (spinnerTimer) return;
      let frame = 0;
      container.classList.add("terminal-view-spinning");
      term.write(`\x1b[2m${SPINNER_FRAMES[0]}\x1b[0m`);
      spinnerTimer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        // Back over the previous glyph and redraw, so it animates in place.
        term.write(`\b\x1b[2m${SPINNER_FRAMES[frame]}\x1b[0m`);
      }, SPINNER_INTERVAL_MS);
    };

    const stopSpinner = () => {
      if (!spinnerTimer) return;
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
      container.classList.remove("terminal-view-spinning");
      term.write("\b \b"); // erase the glyph so the command starts on a clean line
    };

    // Hint first, then the command on its own line with the cursor parked at
    // the end of it (no trailing newline) so it reads like a real prompt.
    term.write(
      "\x1b[2m# Press Return to run, or close this tab to skip.\x1b[0m\r\n",
    );
    term.write(`\x1b[1m$ ${command}\x1b[0m`);

    const startPayload = () => {
      // Refit right before launch so the PTY is spawned at the size the user is
      // actually looking at — npm and friends suppress their progress UI when
      // the reported terminal is too small.
      safeFit();
      return JSON.stringify({
        type: "start",
        cols: term.cols,
        rows: term.rows,
      });
    };

    const sendStart = () => {
      if (started) return;
      started = true;
      if (ws?.readyState === WebSocket.OPEN) ws.send(startPayload());
      else pendingStart = true;
    };

    const connect = () => {
      const socket = new WebSocket(
        terminalSocketUrl(taskId, stepId, sessionId),
      );
      ws = socket;

      socket.onopen = () => {
        reconnectAttempts = 0;
        if (pendingStart) {
          socket.send(startPayload());
          pendingStart = false;
        } else if (started && everConnected) {
          // Resuming a running session after a drop: the server re-attaches the
          // PTY by sessionId and replays the gap, so we only resync the size.
          safeFit();
          socket.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
        }
        everConnected = true;
      };

      socket.onmessage = event => {
        const msg: ServerMessage = JSON.parse(event.data);
        // Any response from the PTY means the wait is over; retire the spinner.
        stopSpinner();
        switch (msg.type) {
          case "data":
            term.write(msg.data);
            break;
          case "error":
            // Terminal: unknown step, or the session was already reaped. Don't
            // reconnect — there's nothing to resume.
            stopped = true;
            term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
            break;
          case "exit":
            exited = true;
            term.write(
              msg.code === 0
                ? `\r\n\x1b[32m✓ Completed successfully.\x1b[0m\r\n`
                : `\r\n\x1b[31m✗ Exited with code ${msg.code}.\x1b[0m\r\n`,
            );
            if (msg.code === 0) {
              window.dispatchEvent(
                new CustomEvent<SetupStepDoneDetail>(SETUP_STEP_DONE_EVENT, {
                  detail: { taskId, stepId },
                }),
              );
            }
            break;
        }
      };

      socket.onclose = () => {
        if (exited || stopped) return;
        // A drop before the command ever launched has nothing to resume; and
        // once we've exhausted retries the server has reaped the PTY.
        if (!started || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          term.write("\r\n\x1b[2m(disconnected)\x1b[0m\r\n");
          return;
        }
        reconnectAttempts++;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    const onData = term.onData(data => {
      if (!started) {
        // Before the command runs, only Return launches it; ignore other keys.
        if (data === "\r" || data === "\n") {
          term.write("\r\n"); // drop to a fresh line before the command's output
          connect(); // open the socket now that there's something to run
          sendStart();
          startSpinner();
        }
        return;
      }
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "input", data }));
    });

    const onResize = term.onResize(({ cols, rows }) => {
      if (started && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const observer = new ResizeObserver(safeFit);
    observer.observe(container);

    return () => {
      // Intentional teardown (tab closed): tell the server to reap the PTY now
      // rather than holding it for the grace window, and don't reconnect.
      stopped = true;
      if (spinnerTimer) clearInterval(spinnerTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "detach" }));
      ws?.close();
      term.dispose();
    };
  }, [taskId, stepId, command]);

  return <div className="terminal-view" ref={containerRef} />;
}
