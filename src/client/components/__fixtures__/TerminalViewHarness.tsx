// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { TerminalView } from "../TerminalView";
import "../../styles.css";

/**
 * Minimal stand-in for the browser `WebSocket` that records the JSON messages
 * the client sends to `window.__terminalSent`, so a component test can assert
 * on them (Playwright's `routeWebSocket` does not intercept the CT page). It
 * "opens" on the next tick so the client's `onopen`/send path runs normally.
 */
class CapturingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = CapturingWebSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = CapturingWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string) {
    try {
      (window as any).__terminalSent.push(JSON.parse(data));
    } catch {
      /* ignore non-JSON */
    }
  }

  close() {
    this.readyState = CapturingWebSocket.CLOSED;
    this.onclose?.({});
  }
}

if (typeof window !== "undefined" && !(window as any).__wsStubbed) {
  (window as any).__wsStubbed = true;
  (window as any).__terminalSent = [];
  (window as any).WebSocket = CapturingWebSocket;
}

interface TerminalViewHarnessProps {
  /** Initial width of the terminal's container, in pixels. */
  width?: number;
  /** Height of the terminal's container, in pixels. */
  height?: number;
}

/**
 * Mounts {@link TerminalView} inside a fixed-size, flex-column container that
 * mimics a real pane, plus a button that widens the container so tests can
 * verify the terminal reports the right size both on launch and on resize.
 */
export function TerminalViewHarness({
  width = 600,
  height = 400,
}: TerminalViewHarnessProps) {
  const [w, setW] = useState(width);
  return (
    <div style={{ width: w, height, display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        data-testid="grow"
        onClick={() => setW(v => v + 400)}
      >
        grow
      </button>
      <TerminalView
        taskId="vercel-ai-sdk"
        stepId="install-ai"
        command="npm i ai"
      />
    </div>
  );
}
