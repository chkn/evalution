// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSSE } from "./useSSE.ts";

/**
 * A stand-in for the browser's `EventSource`, recording every instance so a
 * test can drive opens, messages and failures by hand.
 */
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = 0;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  /** The stream connects successfully. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The stream fails the way a 5xx reconnect response does: closed for good. */
  failClosed(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Error("closed"));
  }

  /** The stream drops, with the browser about to retry on its own. */
  failConnecting(): void {
    this.readyState = 0;
    this.onerror?.(new Error("dropped"));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeEventSource.CLOSED;
  }
}

/** A document whose visibility a test flips by hand. */
function fakeDocument(initial: DocumentVisibilityState = "visible") {
  const target = new EventTarget();
  const doc = Object.assign(target, {
    visibilityState: initial,
    hide() {
      doc.visibilityState = "hidden";
      target.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      doc.visibilityState = "visible";
      target.dispatchEvent(new Event("visibilitychange"));
    },
  });
  return doc;
}

function setup() {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  return FakeEventSource.instances;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connectSSE", () => {
  it("reopens a stream the browser closed for good, and refetches on reconnect", () => {
    // The failure the dev proxy produces while the API server is down: the
    // reconnect gets an HTTP error, so `EventSource` lands in CLOSED and never
    // retries. Without a reopen here the page stops seeing change events
    // entirely — traces and prompts silently stop updating until a reload.
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = setup();
    const onOpen = vi.fn();

    const close = connectSSE({
      onMessage: vi.fn(),
      onOpen,
      retryDelaysMs: [1000],
    });
    instances[0].open();
    expect(onOpen).toHaveBeenCalledTimes(1);

    instances[0].failClosed();
    expect(instances).toHaveLength(1); // not reopened synchronously
    vi.advanceTimersByTime(1000);

    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe("/api/events");
    // The reconnect is what tells the app to refetch whatever changed while
    // the stream was down.
    instances[1].open();
    expect(onOpen).toHaveBeenCalledTimes(2);

    close();
  });

  it("leaves a merely dropped stream to the browser's own retry", () => {
    vi.useFakeTimers();
    const instances = setup();

    const close = connectSSE({ onMessage: vi.fn(), retryDelaysMs: [1000] });
    instances[0].open();
    instances[0].failConnecting();
    vi.advanceTimersByTime(10_000);

    expect(instances).toHaveLength(1);
    close();
  });

  it("backs off over repeated failures, and starts over after a success", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = setup();

    const close = connectSSE({
      onMessage: vi.fn(),
      retryDelaysMs: [1000, 5000],
    });
    instances[0].failClosed();
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(2);

    // Second failure waits the longer delay.
    instances[1].failClosed();
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(2);
    vi.advanceTimersByTime(4000);
    expect(instances).toHaveLength(3);

    // A stream that connects resets the schedule.
    instances[2].open();
    instances[2].failClosed();
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(4);

    close();
  });

  it("stops reconnecting once closed", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = setup();

    const close = connectSSE({ onMessage: vi.fn(), retryDelaysMs: [1000] });
    instances[0].failClosed();
    close();
    vi.advanceTimersByTime(60_000);

    expect(instances).toHaveLength(1);
    expect(instances[0].closeCalls).toBe(1);
  });

  it("closes the stream while the tab stays hidden, and reopens it when shown", () => {
    // With no stream open the server stops watching trace providers, so a
    // tab left in the background doesn't poll Evalution Cloud all night.
    vi.useFakeTimers();
    const instances = setup();
    const doc = fakeDocument();
    const onOpen = vi.fn();

    const close = connectSSE({
      onMessage: vi.fn(),
      onOpen,
      doc,
      hiddenGraceMs: 60_000,
    });
    instances[0].open();

    // A quick look at another tab keeps the stream.
    doc.hide();
    vi.advanceTimersByTime(30_000);
    doc.show();
    vi.advanceTimersByTime(60_000);
    expect(instances[0].closeCalls).toBe(0);

    doc.hide();
    vi.advanceTimersByTime(60_000);
    expect(instances[0].closeCalls).toBe(1);
    expect(instances).toHaveLength(1);

    // Coming back reopens it, and the reopen refetches what was missed.
    doc.show();
    expect(instances).toHaveLength(2);
    instances[1].open();
    expect(onOpen).toHaveBeenCalledTimes(2);

    close();
    // Nothing reopens it once closed.
    doc.hide();
    doc.show();
    expect(instances).toHaveLength(2);
  });

  it("doesn't open the stream in a tab that starts hidden until it's shown", () => {
    vi.useFakeTimers();
    const instances = setup();
    const doc = fakeDocument("hidden");

    const close = connectSSE({ onMessage: vi.fn(), doc });
    expect(instances).toHaveLength(0);
    doc.show();
    expect(instances).toHaveLength(1);
    close();
  });

  it("doesn't reopen a stream that was closed for being hidden", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = setup();
    const doc = fakeDocument();

    const close = connectSSE({
      onMessage: vi.fn(),
      doc,
      hiddenGraceMs: 1000,
      retryDelaysMs: [500],
    });
    instances[0].failClosed();
    doc.hide();
    vi.advanceTimersByTime(60_000);
    // The retry pending when the tab was hidden doesn't count.
    expect(instances.filter(es => es.readyState !== 2)).toHaveLength(0);
    close();
  });

  it("delivers parsed messages and survives a malformed one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const instances = setup();
    const onMessage = vi.fn();

    const close = connectSSE({ onMessage });
    instances[0].open();
    instances[0].onmessage?.({ data: "not json" });
    instances[0].onmessage?.({ data: JSON.stringify({ type: "connected" }) });

    expect(onMessage.mock.calls).toEqual([[{ type: "connected" }]]);
    close();
  });
});
