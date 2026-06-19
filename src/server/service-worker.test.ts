// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import { createMemoryApp, RUN_LOCALLY_MESSAGE } from "./service-worker.ts";

const ROOT = "/demo";
const PROMPT_PATH = `${ROOT}/cool.prompt.ts`;

function coolPrompt(model = "gpt-5.5"): string {
  return `import { prompts } from "@evalution/vercel-ai-sdk";

export default prompts(
  { id: "demo" },
  ({ openai }) => ({
    weatherAgent: (query: string) => ({
      model: openai(${JSON.stringify(model)}),
      system: "You answer questions about the weather.",
      messages: [{ role: "user", content: query }],
      temperature: 0.7,
    }),
  }),
);
`;
}

function makeApp() {
  return createMemoryApp({
    files: {
      [PROMPT_PATH]: coolPrompt(),
      [`${ROOT}/.evalution/config.ts`]: "export default {};\n",
    },
  });
}

/**
 * Wraps a streaming SSE Response in a stateful reader. The returned `next`
 * resolves the first parsed `data:` event matching `predicate` (buffering any
 * non-matching events across calls), or `undefined` on timeout — so a single
 * reader can be used across several `next()` calls without locking errors.
 */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pending: any[] = [];
  let waiters: Array<() => void> = [];
  let closed = false;
  const wake = () => {
    waiters.forEach(w => {
      w();
    });
    waiters = [];
  };

  // Background pump: drain the reader continuously so no frames are lost
  // between `next()` calls.
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: too lazy to fix
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find(l => l.startsWith("data:"));
          if (dataLine) {
            pending.push(JSON.parse(dataLine.slice("data:".length).trim()));
            wake();
          }
        }
      }
    } catch {
      /* reader cancelled */
    }
    closed = true;
    wake();
  })();

  async function next(
    predicate: (event: any) => boolean,
    timeoutMs = 2000,
  ): Promise<any | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (pending.length) {
        const event = pending.shift();
        if (predicate(event)) return event;
      }
      if (closed || Date.now() >= deadline) return undefined;
      await Promise.race([
        new Promise<void>(r => waiters.push(r)),
        new Promise<void>(r => setTimeout(r, deadline - Date.now())),
      ]);
    }
  }

  return { next, cancel: () => reader.cancel().catch(() => {}) };
}

describe("createMemoryApp", () => {
  it("lists the seeded prompt", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/prompts");
    expect(res.status).toBe(200);
    const prompts = (await res.json()) as any[];
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("weatherAgent");
    // FilePromptProvider auto-numbers ids ("fs", "fs2", …) per instance.
    expect(prompts[0].providerId).toMatch(/^fs/);
  });

  it("reads and writes raw files under the root via /api/files", async () => {
    const { app } = await makeApp();

    const read = await app.request(
      `/api/files?path=${encodeURIComponent(PROMPT_PATH)}`,
    );
    expect(read.status).toBe(200);
    expect(((await read.json()) as any).content).toContain("weatherAgent");

    const updated = coolPrompt("claude-opus-4-8");
    const write = await app.request("/api/files", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: PROMPT_PATH, content: updated }),
    });
    expect(write.status).toBe(200);

    const reread = await app.request(
      `/api/files?path=${encodeURIComponent(PROMPT_PATH)}`,
    );
    expect(((await reread.json()) as any).content).toBe(updated);
  });

  it("rejects file paths outside the project root", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/files?path=/etc/passwd");
    expect(res.status).toBe(400);
  });

  it("disables execution with a run-locally message", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/prompts/fs/anyid/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ functionParams: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe(RUN_LOCALLY_MESSAGE);
  });

  it("reports no onboarding setup tasks", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/setup-tasks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agent: [], sdk: [] });
  });

  it("broadcasts prompt-changed over /api/events when a file is written", async () => {
    const { app } = await makeApp();

    const events = sseReader(await app.request("/api/events"));
    // Drain the initial "connected" frame so the subscriber is registered.
    expect(await events.next(e => e.type === "connected")).toBeDefined();

    // Write through /api/files; the watcher should fan out prompt-changed.
    await app.request("/api/files", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: PROMPT_PATH,
        content: coolPrompt("claude-opus-4-8"),
      }),
    });

    const event = await events.next(e => e.type === "prompt-changed");
    expect(event).toBeDefined();
    expect(event.providerId).toMatch(/^fs/);
    await events.cancel();
  });
});
