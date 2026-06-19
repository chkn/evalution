// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import * as pty from "@lydell/node-pty";
import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { setupStepCommand } from "../shared/setup-task.ts";
import { findSetupStep } from "./setup-tasks.ts";

/**
 * Messages the terminal client sends up the WebSocket. The command is never
 * sent by the client — it is resolved server-side from the setup registry by
 * the `taskId`/`stepId` query params — so these only ever carry intent (start,
 * keystrokes, resize, detach), not anything the server will execute verbatim.
 */
type ClientMessage =
  | { type: "start"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  // Sent when the client intentionally leaves (tab closed): reap the PTY now
  // instead of holding it for the reconnect grace window.
  | { type: "detach" };

/** Messages the server streams down to the terminal client. */
type ServerMessage =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

/** Shell used to run a resolved step command, so shell syntax in it works. */
const SHELL =
  process.env.SHELL ||
  (process.platform === "win32" ? "powershell.exe" : "bash");

/**
 * How long a session's PTY is kept alive after its WebSocket drops, waiting for
 * the client to reconnect. Covers the brief gap while the server restarts
 * itself once a config file appears, so the coding agent isn't killed mid-task.
 */
const GRACE_PERIOD_MS = 10_000;

/**
 * Arguments to run `command` in {@link SHELL}, skipping the user's startup files
 * where the shell allows it. Those rc files (e.g. nvm in `~/.zshrc`) can add
 * seconds of latency before the command even begins, and they are unnecessary
 * here: the PTY inherits the server process's `PATH`, so tools resolve without
 * them.
 */
export function shellCommandArgs(command: string): string[] {
  const shell = SHELL.toLowerCase();
  if (shell.includes("zsh")) return ["-f", "-c", command];
  if (shell.includes("bash")) return ["--norc", "--noprofile", "-c", command];
  return ["-c", command];
}

/**
 * Resolves the shell command a terminal should run for a setup step, looking it
 * up in the server's own registry rather than trusting anything from the client.
 * Returns `null` when the step is unknown or is not a runnable command (e.g.
 * `create_config`, which writes a file instead of running in a terminal).
 */
export function resolveTerminalCommand(
  taskId: string,
  stepId: string,
): string | null {
  const step = findSetupStep(taskId, stepId);
  if (!step || step.kind === "create_config") return null;
  return setupStepCommand(step);
}

/**
 * The subset of `@lydell/node-pty`'s `IPty` a {@link TerminalSession} relies on.
 * Narrowing to this lets tests drive a session with a fake PTY. The real
 * `IPty` satisfies it.
 */
export interface PtyLike {
  /** OS process id of the spawned shell. */
  readonly pid: number;
  /** Subscribe to output produced by the PTY. */
  onData(listener: (data: string) => void): void;
  /** Subscribe to the PTY process exiting. */
  onExit(listener: (event: { exitCode: number }) => void): void;
  /** Write bytes to the PTY's input (the user's keystrokes). */
  write(data: string): void;
  /** Resize the PTY to `cols`×`rows`. */
  resize(cols: number, rows: number): void;
  /** Terminate the PTY process (and, via the closing master fd, its tree). */
  kill(): void;
}

/**
 * The subset of a WebSocket connection a {@link TerminalSession} writes to.
 * Hono's `WSContext` satisfies it; tests pass a fake.
 */
export interface SocketLike {
  /** Send a text frame to the client. */
  send(data: string): void;
  /** Close the connection. */
  close(): void;
}

/** Inputs needed to spawn a PTY for a new {@link TerminalSession}. */
export interface SpawnOptions {
  /** The shell command line to run (resolved server-side, never client-sent). */
  command: string;
  /** Initial column count for the PTY. */
  cols: number;
  /** Initial row count for the PTY. */
  rows: number;
  /** Working directory for the spawned process (the project root). */
  cwd: string;
  /** Environment for the spawned process. */
  env: Record<string, string>;
}

/** Spawns a {@link PtyLike} for the given options. Injectable for testing. */
export type Spawn = (options: SpawnOptions) => PtyLike;

/** Spawns a real `node-pty` PTY running the command in {@link SHELL}. */
function defaultSpawn(options: SpawnOptions): PtyLike {
  return pty.spawn(SHELL, shellCommandArgs(options.command), {
    name: "xterm-color",
    cols: options.cols || 80,
    rows: options.rows || 24,
    cwd: options.cwd,
    env: options.env,
  });
}

/**
 * A single onboarding terminal: one PTY plus the WebSocket currently attached to
 * it. The PTY outlives any one socket so it can survive the server restart that
 * happens when a config file appears — while a client is attached, output is
 * streamed live; while it is detached, output is buffered and a grace timer
 * reaps the PTY if no client reconnects in time.
 */
export class TerminalSession {
  /** While detached: PTY output accumulated to replay on reconnect. */
  private buffer: string[] | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: SocketLike | null = null;
  private exited = false;
  private readonly child: PtyLike;
  private readonly onReap: () => void;
  private readonly gracePeriodMs: number;

  /**
   * @param child - The PTY this session owns.
   * @param onReap - Called once the session is done (exit, grace expiry, or
   *   intentional kill) so the registry can drop it.
   * @param gracePeriodMs - How long to keep the PTY alive after the socket drops.
   */
  constructor(
    child: PtyLike,
    onReap: () => void,
    gracePeriodMs: number = GRACE_PERIOD_MS,
  ) {
    this.child = child;
    this.onReap = onReap;
    this.gracePeriodMs = gracePeriodMs;
    child.onData(data => this.handleData(data));
    child.onExit(({ exitCode }) => this.handleExit(exitCode));
  }

  private send(message: ServerMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private handleData(data: string): void {
    if (this.socket) this.send({ type: "data", data });
    else this.buffer?.push(data);
  }

  private handleExit(code: number): void {
    this.exited = true;
    this.send({ type: "exit", code });
    this.socket?.close();
    this.clearGrace();
    this.onReap();
  }

  /**
   * Attach a (re)connected socket. Replays any output buffered while detached,
   * then resumes live streaming. Cancels a pending grace-period reap.
   */
  attach(ws: SocketLike): void {
    this.clearGrace();
    this.socket = ws;
    if (this.buffer) {
      for (const data of this.buffer) this.send({ type: "data", data });
      this.buffer = null;
    }
  }

  /**
   * The attached socket dropped (e.g. the server is restarting). Start buffering
   * output and a grace timer; if no client reattaches in time, reap the PTY.
   */
  detach(): void {
    if (this.exited || !this.socket) return;
    this.socket = null;
    this.buffer = [];
    this.graceTimer = setTimeout(() => {
      this.buffer = null;
      if (!this.exited) this.child.kill();
      this.onReap();
    }, this.gracePeriodMs);
  }

  /** The client intentionally left: kill the PTY now, skipping the grace wait. */
  kill(): void {
    this.clearGrace();
    this.socket = null;
    this.buffer = null;
    if (!this.exited) this.child.kill();
    this.onReap();
  }

  /** Forward the user's keystrokes to the PTY. */
  write(data: string): void {
    this.child.write(data);
  }

  /** Resize the PTY to match the client's terminal. */
  resize(cols: number, rows: number): void {
    this.child.resize(cols || 80, rows || 24);
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }
}

/**
 * Holds the live {@link TerminalSession | terminal sessions} keyed by a
 * client-supplied session id. Owned by the CLI process (not by any one server
 * instance) so sessions — and the PTYs they wrap — survive the server restart
 * that happens when a config file appears.
 */
export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly spawn: Spawn;
  private readonly gracePeriodMs: number;

  /**
   * @param spawn - PTY spawner; overridable in tests.
   * @param gracePeriodMs - Reconnect grace window passed to each session.
   */
  constructor(
    spawn: Spawn = defaultSpawn,
    gracePeriodMs: number = GRACE_PERIOD_MS,
  ) {
    this.spawn = spawn;
    this.gracePeriodMs = gracePeriodMs;
  }

  /** The session for `id`, if one is still live. */
  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** Spawn a PTY and register a new session under `id`. */
  create(id: string, options: SpawnOptions): TerminalSession {
    const child = this.spawn(options);
    const session = new TerminalSession(
      child,
      () => this.sessions.delete(id),
      this.gracePeriodMs,
    );
    this.sessions.set(id, session);
    return session;
  }
}

function sendError(ws: WSContext, message: string): void {
  ws.send(JSON.stringify({ type: "error", message } satisfies ServerMessage));
}

/**
 * Registers the interactive-terminal WebSocket route at `/api/terminal`.
 *
 * The client connects with `taskId`, `stepId`, and a client-generated
 * `sessionId` query param. The server resolves the actual command from its own
 * registry (never from the request body). On the first connection for a session
 * the client signals `start` and the server spawns the command in a PTY rooted
 * at the project; output is streamed to the client and the client's keystrokes
 * are written to the process, so prompts (e.g. npm's "Ok to proceed?") work.
 *
 * Sessions live in `sessions`, which outlives this server instance, so when the
 * server restarts itself after a config file appears the PTY keeps running and a
 * reconnecting client (same `sessionId`) re-attaches and replays the gap.
 *
 * The trust boundary mirrors the step-execute route: the client can only ask to
 * run a step that already exists server-side.
 */
export function registerTerminalRoute(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  rootPath: string,
  sessions: TerminalSessionRegistry,
): void {
  app.get(
    "/api/terminal",
    upgradeWebSocket(c => {
      const taskId = c.req.query("taskId");
      const stepId = c.req.query("stepId");
      // Falls back to a per-step key so older clients without a sessionId still
      // get a stable id (at the cost of colliding if the step is opened twice).
      const sessionId = c.req.query("sessionId") ?? `${taskId}:${stepId}`;
      let session: TerminalSession | undefined;
      // Set when the client asked us to reap on close, so onClose doesn't also
      // start a (now pointless) grace period.
      let leaving = false;

      return {
        onOpen(_evt, ws) {
          // Reconnect: an existing session for this id resumes immediately,
          // replaying anything produced while the socket was gone.
          const existing = sessions.get(sessionId);
          if (existing) {
            session = existing;
            existing.attach(ws);
          }
        },
        onMessage(evt, ws) {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          switch (msg.type) {
            case "start": {
              if (session) return; // already running/attached; ignore
              const command =
                taskId && stepId
                  ? resolveTerminalCommand(taskId, stepId)
                  : null;
              if (!command) {
                sendError(ws, "Unknown or non-runnable setup step.");
                ws.close();
                return;
              }
              session = sessions.create(sessionId, {
                command,
                cols: msg.cols,
                rows: msg.rows,
                cwd: rootPath,
                env: process.env as Record<string, string>,
              });
              session.attach(ws);
              break;
            }
            case "input":
              session?.write(msg.data);
              break;
            case "resize":
              session?.resize(msg.cols || 80, msg.rows || 24);
              break;
            case "detach":
              leaving = true;
              session?.kill();
              break;
          }
        },
        onClose() {
          // A plain socket drop (server restart, network blip) detaches and
          // starts the grace window; an explicit `detach` already reaped it.
          if (!leaving) session?.detach();
        },
      };
    }),
  );
}
