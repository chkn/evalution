// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import * as pty from "@lydell/node-pty";
import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { findSetupStep } from "../sdk/registry.ts";
import { setupStepCommand } from "../shared/setup-task.ts";

/**
 * Messages the terminal client sends up the WebSocket. The command is never
 * sent by the client — it is resolved server-side from the setup registry by
 * the `taskId`/`stepId` query params — so these only ever carry intent (start,
 * keystrokes, resize), not anything the server will execute verbatim.
 */
type ClientMessage =
  | { type: "start"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

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

function send(ws: WSContext, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

/**
 * Registers the interactive-terminal WebSocket route at `/api/terminal`.
 *
 * The client connects with `taskId` and `stepId` query params identifying a
 * setup step; the server resolves the actual command from its own registry
 * (never from the request body) and, once the client signals `start`, spawns it
 * in a PTY rooted at the project. Output is streamed to the client and the
 * client's keystrokes are written to the process, so prompts (e.g. npm's
 * "Ok to proceed?") work. The trust boundary mirrors the step-execute route:
 * the client can only ask to run a step that already exists server-side.
 */
export function registerTerminalRoute(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  rootPath: string,
): void {
  app.get(
    "/api/terminal",
    upgradeWebSocket(c => {
      const taskId = c.req.query("taskId");
      const stepId = c.req.query("stepId");
      let child: pty.IPty | undefined;

      const start = (ws: WSContext, cols: number, rows: number) => {
        if (child) return; // already running; ignore duplicate starts
        const command =
          taskId && stepId ? resolveTerminalCommand(taskId, stepId) : null;
        if (!command) {
          send(ws, {
            type: "error",
            message: "Unknown or non-runnable setup step.",
          });
          ws.close();
          return;
        }

        child = pty.spawn(SHELL, shellCommandArgs(command), {
          name: "xterm-color",
          cols: cols || 80,
          rows: rows || 24,
          cwd: rootPath,
          env: process.env as Record<string, string>,
        });
        child.onData(data => send(ws, { type: "data", data }));
        child.onExit(({ exitCode }) => {
          send(ws, { type: "exit", code: exitCode });
          ws.close();
        });
      };

      return {
        onMessage(evt, ws) {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          switch (msg.type) {
            case "start":
              start(ws, msg.cols, msg.rows);
              break;
            case "input":
              child?.write(msg.data);
              break;
            case "resize":
              child?.resize(msg.cols || 80, msg.rows || 24);
              break;
          }
        },
        onClose() {
          child?.kill();
          child = undefined;
        },
      };
    }),
  );
}
