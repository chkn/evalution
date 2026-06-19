// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PtyLike,
  resolveTerminalCommand,
  type SocketLike,
  type SpawnOptions,
  shellCommandArgs,
  TerminalSession,
  TerminalSessionRegistry,
} from "./terminal.ts";

describe("resolveTerminalCommand", () => {
  it("maps an install_package step to its npm command", () => {
    expect(resolveTerminalCommand("vercel-ai-sdk", "install-ai")).toBe(
      "npm i ai",
    );
  });

  it("returns null for a create_config step (it writes a file, not a command)", () => {
    expect(resolveTerminalCommand("vercel-ai-sdk", "create-config")).toBeNull();
  });

  it("returns null for unknown task or step ids", () => {
    expect(resolveTerminalCommand("nope", "install-ai")).toBeNull();
    expect(resolveTerminalCommand("vercel-ai-sdk", "nope")).toBeNull();
  });
});

describe("shellCommandArgs", () => {
  it("passes the command through the shell via -c, whatever the shell", () => {
    const args = shellCommandArgs("npm i ai");
    // The last two args are always `-c <command>`; any earlier args are the
    // shell-specific flags that skip startup files.
    expect(args.slice(-2)).toEqual(["-c", "npm i ai"]);
  });
});

/** Controllable stand-in for a node-pty process. */
class FakePty implements PtyLike {
  readonly pid = 4242;
  killed = false;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  private dataCb?: (data: string) => void;
  private exitCb?: (event: { exitCode: number }) => void;

  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (event: { exitCode: number }) => void) {
    this.exitCb = cb;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  kill() {
    this.killed = true;
  }

  /** Simulate the PTY producing output. */
  emit(data: string) {
    this.dataCb?.(data);
  }
  /** Simulate the PTY process exiting. */
  exit(code: number) {
    this.exitCb?.({ exitCode: code });
  }
}

/** Records the JSON frames written to a (fake) client socket. */
class FakeSocket implements SocketLike {
  readonly sent: Array<{ type: string; data?: string; code?: number }> = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
}

/** The `data` payloads a socket received, in order. */
const dataFrames = (sock: FakeSocket): string[] =>
  sock.sent.filter(m => m.type === "data").map(m => m.data!);

describe("TerminalSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams PTY output to the attached socket", () => {
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => {}, 100);
    const sock = new FakeSocket();
    session.attach(sock);

    pty.emit("hello");
    pty.emit(" world");

    expect(dataFrames(sock)).toEqual(["hello", " world"]);
  });

  it("buffers output while detached and replays it once on reconnect", () => {
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => {}, 100);
    const first = new FakeSocket();
    session.attach(first);
    pty.emit("a");

    session.detach();
    pty.emit("b"); // produced during the disconnected gap
    pty.emit("c");

    const second = new FakeSocket();
    session.attach(second);

    // The gap output is replayed to the reconnected socket, in order...
    expect(dataFrames(second)).toEqual(["b", "c"]);
    // ...the original socket only ever saw what arrived before the drop...
    expect(dataFrames(first)).toEqual(["a"]);

    // ...and live streaming resumes without re-replaying the (now destroyed)
    // buffer.
    pty.emit("d");
    expect(dataFrames(second)).toEqual(["b", "c", "d"]);
  });

  it("reaps the PTY when the grace period expires with no reconnect", () => {
    vi.useFakeTimers();
    let reaped = 0;
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => reaped++, 100);
    session.attach(new FakeSocket());

    session.detach();
    expect(pty.killed).toBe(false);

    vi.advanceTimersByTime(100);
    expect(pty.killed).toBe(true);
    expect(reaped).toBe(1);
  });

  it("cancels the grace-period reap when a client reconnects in time", () => {
    vi.useFakeTimers();
    let reaped = 0;
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => reaped++, 100);
    session.attach(new FakeSocket());

    session.detach();
    vi.advanceTimersByTime(50);
    session.attach(new FakeSocket()); // reconnect before the window closes
    vi.advanceTimersByTime(100);

    expect(pty.killed).toBe(false);
    expect(reaped).toBe(0);
  });

  it("forwards the exit frame, closes the socket, and reaps on exit", () => {
    let reaped = 0;
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => reaped++, 100);
    const sock = new FakeSocket();
    session.attach(sock);

    pty.exit(0);

    expect(sock.sent).toContainEqual({ type: "exit", code: 0 });
    expect(sock.closed).toBe(true);
    expect(reaped).toBe(1);
  });

  it("kills the PTY immediately on intentional close, skipping the grace wait", () => {
    let reaped = 0;
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => reaped++, 100);
    session.attach(new FakeSocket());

    session.kill();

    expect(pty.killed).toBe(true);
    expect(reaped).toBe(1);
  });

  it("forwards keystrokes and resizes to the PTY", () => {
    const pty = new FakePty();
    const session = new TerminalSession(pty, () => {}, 100);
    session.attach(new FakeSocket());

    session.write("ls\r");
    session.resize(120, 40);

    expect(pty.writes).toEqual(["ls\r"]);
    expect(pty.resizes).toEqual([[120, 40]]);
  });
});

describe("TerminalSessionRegistry", () => {
  const opts: SpawnOptions = {
    command: "claude",
    cols: 80,
    rows: 24,
    cwd: "/project",
    env: {},
  };

  it("spawns with the given options and tracks the session by id", () => {
    let seen: SpawnOptions | undefined;
    const registry = new TerminalSessionRegistry(o => {
      seen = o;
      return new FakePty();
    }, 100);

    const session = registry.create("sess-1", opts);

    expect(seen).toEqual(opts);
    expect(registry.get("sess-1")).toBe(session);
  });

  it("drops a session from the registry once it is reaped", () => {
    const registry = new TerminalSessionRegistry(() => new FakePty(), 100);
    const session = registry.create("sess-1", opts);

    session.kill();

    expect(registry.get("sess-1")).toBeUndefined();
  });
});
