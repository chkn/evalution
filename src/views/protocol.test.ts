// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { describe, expect, it } from "vitest";
import type { Span, TraceWithSpans } from "../trace/trace-types.ts";
import {
  type FrameStatus,
  hostReceive,
  NEW_FRAME,
  ViewChannel,
} from "./host.ts";
import {
  type FrameMessage,
  PROTOCOL,
  parseFrameMessage,
  type ViewTheme,
} from "./protocol.ts";
import { type FrameState, frameStep, INITIAL_FRAME_STATE } from "./runtime.ts";
import type { Surface } from "./surface.ts";
import { datasetSurface, datasetView } from "./surfaces/datasets.ts";
import { traceSurface, traceView } from "./surfaces/trace.ts";
import { defineView, type ViewProps } from "./view.ts";

/**
 * A toy surface, so the generic layer is tested against something that
 * isn't a trace: a counter that events add to, a `highlight` context, and
 * one action of each kind.
 */
interface ToyProps extends ViewProps {
  count: number;
  highlight: string;
  poke(): void;
  commit(value: number): void;
}
const toy: Surface<number, number, string, ToyProps> = {
  name: "toys",
  helper: "toyView",
  applyEvent: (count, add) => count + add,
  isFinal: count => count >= 100,
  actions: {
    poke: { effect: "ephemeral", check: () => undefined },
    commit: {
      effect: "effectful",
      check: args =>
        typeof (args as { value?: unknown })?.value === "number"
          ? undefined
          : "commit needs a value",
    },
  },
  props: ({ subject, context }, send, base) => ({
    ...base,
    count: subject,
    highlight: context,
    poke: () => send("poke", {}),
    commit: value => send("commit", { value }),
  }),
};
const theme: ViewTheme = { mode: "light", tokens: { "--ev-bg": "#fff" } };

const evenView = defineView(toy, {
  applies: count => count % 2 === 0,
  mount: () => ({ update() {} }),
});

describe("frameStep", () => {
  const init = (subject: number) =>
    frameStep(evenView, INITIAL_FRAME_STATE as FrameState<number, string>, {
      type: "init",
      subject,
      rev: 1,
      context: "x",
      theme,
    });

  it("answers applies after init, and mounts when it does", () => {
    const { state, out, effects } = init(2);
    expect(out).toEqual([{ type: "applies", value: true }]);
    expect(effects).toEqual([{ kind: "theme", theme }, { kind: "mount" }]);
    expect(state).toMatchObject({ rev: 1, applies: true, mounted: true });
  });

  it("doesn't mount a view that doesn't apply", () => {
    const { out, effects } = init(1);
    expect(out).toEqual([{ type: "applies", value: false }]);
    expect(effects).toEqual([{ kind: "theme", theme }]);
  });

  it("folds events through the surface's reducer, reporting applies only when it changes", () => {
    let { state } = init(1);
    const step = (add: number, rev: number) => {
      const r = frameStep(evenView, state, { type: "event", event: add, rev });
      state = r.state;
      return r;
    };
    expect(step(1, 2)).toMatchObject({
      out: [{ type: "applies", value: true }],
      effects: [{ kind: "mount" }],
    });
    expect(state.known?.subject).toBe(2);
    expect(step(2, 3)).toMatchObject({
      out: [],
      effects: [{ kind: "update" }],
    });
    expect(step(1, 4)).toMatchObject({
      out: [{ type: "applies", value: false }],
      effects: [{ kind: "unmount" }],
    });
    expect(state.rev).toBe(4);
  });

  it("updates a mounted view on a context change", () => {
    const { state } = init(2);
    const r = frameStep(evenView, state, {
      type: "context",
      context: "y",
      rev: 2,
    });
    expect(r.effects).toEqual([{ kind: "update" }]);
    expect(r.state.known?.context).toBe("y");
  });

  it("reports an applies that throws, and treats it as not applying", () => {
    const throwing = defineView(toy, {
      applies: () => {
        throw new Error("boom");
      },
      mount: () => ({ update() {} }),
    });
    const r = frameStep(throwing, INITIAL_FRAME_STATE, {
      type: "init",
      subject: 0,
      rev: 1,
      context: "",
      theme,
    });
    expect(r.out).toEqual([
      { type: "error", message: "boom", during: "applies" },
      { type: "applies", value: false },
    ]);
  });
});

describe("hostReceive", () => {
  const channel = () => {
    const c = new ViewChannel<number, number, string>(
      toy as Surface<number, number, string, ViewProps>,
      "x",
    );
    c.setSubject(4);
    return c;
  };
  const receive = (
    message: FrameMessage,
    {
      status = { ready: true, applies: true } as FrameStatus,
      visible = true,
      c = channel(),
    } = {},
  ) =>
    hostReceive(toy as Surface<number, number, string, ViewProps>, message, {
      status,
      channel: c,
      theme,
      visible,
    });

  it("answers a good ready with init", () => {
    const r = receive(
      { type: "ready", protocol: PROTOCOL, surface: "toys", label: "Toy" },
      { status: NEW_FRAME },
    );
    expect(r.status).toEqual({ ready: true, label: "Toy" });
    expect(r.reply).toEqual([
      { type: "init", subject: 4, rev: 1, context: "x", theme },
    ]);
  });

  it("asks for a rebuild on another protocol, and refuses another surface", () => {
    expect(
      receive({ type: "ready", protocol: PROTOCOL + 1 }, { status: NEW_FRAME })
        .status.error,
    ).toContain("Rebuild it");
    expect(
      receive(
        { type: "ready", protocol: PROTOCOL, surface: "traces" },
        { status: NEW_FRAME },
      ).status.error,
    ).toContain("traces surface");
  });

  it("ignores every action and openUrl from a hidden frame", () => {
    expect(
      receive(
        { type: "action", name: "poke", args: {}, rev: 1 },
        { visible: false },
      ),
    ).toEqual({ status: { ready: true, applies: true }, reply: [] });
    expect(
      receive(
        { type: "action", name: "commit", args: { value: 1 }, rev: 1 },
        { visible: false },
      ).action,
    ).toBeUndefined();
    expect(
      receive({ type: "openUrl", url: "https://a.example" }, { visible: false })
        .openUrl,
    ).toBeUndefined();
  });

  it("accepts a checked action from the visible frame", () => {
    expect(
      receive({ type: "action", name: "commit", args: { value: 3 }, rev: 1 })
        .action,
    ).toEqual({ name: "commit", args: { value: 3 }, effect: "effectful" });
  });

  it("rejects an unknown action, or one whose check fails", () => {
    expect(
      receive({ type: "action", name: "toString", args: {}, rev: 1 }).reply,
    ).toEqual([
      {
        type: "rejected",
        name: "toString",
        reason: "no action toString on toys",
      },
    ]);
    expect(
      receive({ type: "action", name: "commit", args: {}, rev: 1 }).reply,
    ).toEqual([
      { type: "rejected", name: "commit", reason: "commit needs a value" },
    ]);
  });

  it("rejects an effectful action made against an earlier rev, and resends the context", () => {
    const c = channel();
    c.setContext("y");
    const r = receive(
      { type: "action", name: "commit", args: { value: 3 }, rev: 1 },
      { c },
    );
    expect(r.action).toBeUndefined();
    expect(r.reply).toEqual([
      expect.objectContaining({ type: "rejected", name: "commit" }),
      { type: "context", context: "y", rev: 2 },
    ]);
    // An ephemeral one doesn't care.
    expect(
      receive({ type: "action", name: "poke", args: {}, rev: 1 }, { c }).action,
    ).toBeDefined();
  });

  it("opens only http(s) URLs", () => {
    expect(
      receive({ type: "openUrl", url: "https://a.example/x?y" }).openUrl,
    ).toBe("https://a.example/x?y");
    expect(
      receive({ type: "openUrl", url: "javascript:alert(1)" }).openUrl,
    ).toBeUndefined();
    expect(
      receive({ type: "openUrl", url: "/relative" }).openUrl,
    ).toBeUndefined();
  });

  it("marks a frame whose applies threw as failed", () => {
    expect(
      receive({ type: "error", message: "boom", during: "applies" }).status,
    ).toMatchObject({ applies: false, error: "boom" });
    expect(receive({ type: "error", message: "oops" }).status).toMatchObject({
      renderError: "oops",
    });
  });
});

describe("ViewChannel", () => {
  it("stamps each change with a new rev and tells listeners", () => {
    const c = new ViewChannel(
      toy as Surface<number, number, string, ViewProps>,
      "x",
    );
    const seen: unknown[] = [];
    c.subscribe((message, change) => seen.push([message, change]));
    c.event(1); // no subject yet: ignored
    c.setSubject(1);
    c.event(2);
    c.setContext("y");
    expect(seen).toEqual([
      [{ type: "subject", subject: 1, rev: 1 }, "subject"],
      [{ type: "event", event: 2, rev: 2 }, "subject"],
      [{ type: "context", context: "y", rev: 3 }, "context"],
    ]);
    expect(c.state).toEqual({ subject: 3, context: "y" });
  });
});

describe("parseFrameMessage", () => {
  it("refuses anything that isn't a well-formed message", () => {
    expect(parseFrameMessage(null)).toBeUndefined();
    expect(parseFrameMessage({ type: "action", name: "x" })).toBeUndefined();
    expect(
      parseFrameMessage({ type: "applies", value: "yes" }),
    ).toBeUndefined();
    expect(parseFrameMessage({ type: "nope" })).toBeUndefined();
    expect(
      parseFrameMessage({
        type: "action",
        name: "x",
        args: 1,
        rev: 2,
        extra: 3,
      }),
    ).toEqual({ type: "action", name: "x", args: 1, rev: 2 });
  });
});

const span = (id: string, extra: Partial<Span> = {}): Span => ({
  id,
  traceId: "t",
  name: id,
  kind: "TOOL",
  startTime: 0,
  ...extra,
});

describe("the trace surface", () => {
  const subject: TraceWithSpans = {
    trace: { id: "t", name: "t", startTime: 0, status: "running" },
    spans: [span("a")],
  };

  it("folds span events, and is final once the trace has ended", () => {
    const next = traceSurface.applyEvent!(subject, {
      type: "span-start",
      span: span("b"),
    });
    expect(next.spans.map(s => s.id)).toEqual(["a", "b"]);
    expect(traceSurface.isFinal(next)).toBe(false);
    const ended = traceSurface.applyEvent!(next, {
      type: "trace-end",
      trace: { ...subject.trace, status: "ok", endTime: 5 },
    });
    expect(traceSurface.isFinal(ended)).toBe(true);
  });

  it("honors selectSpan only for a span in the trace", () => {
    const state = { subject, context: { selectedSpanId: null } };
    const { check } = traceSurface.actions.selectSpan;
    expect(check({ spanId: "a" }, state)).toBeUndefined();
    expect(check({ spanId: "zzz" }, state)).toContain("no span");
    expect(check("a", state)).toBeDefined();
  });

  it("tags views with itself", () => {
    const view = traceView({
      applies: () => true,
      mount: () => ({ update() {} }),
    });
    const sent: unknown[] = [];
    const props = traceSurface.props(
      { subject, context: { selectedSpanId: "a" } },
      (name, args) => sent.push([name, args]),
      { openUrl() {} },
    );
    props.selectSpan("a");
    expect(sent).toEqual([["selectSpan", { spanId: "a" }]]);
    expect(props.trace).toBe(subject);
    expect(
      frameStep(view, INITIAL_FRAME_STATE, {
        type: "init",
        subject,
        rev: 1,
        context: { selectedSpanId: null },
        theme,
      }).out,
    ).toEqual([{ type: "applies", value: true }]);
  });
});

describe("the datasets surface", () => {
  const row = { id: "r1", cells: {}, createdAt: 0 };
  const state = {
    subject: {
      dataset: { id: "d", name: "d", fields: [], createdAt: 0, updatedAt: 0 },
      overview: { rowCount: 2, fields: {}, instances: {} },
    },
    context: { selected: { index: 0, row } },
  };

  it("lets a view propose changes only to the row it's showing", () => {
    const { check } = datasetSurface.actions.proposeUpdate;
    expect(datasetSurface.actions.proposeUpdate.effect).toBe("effectful");
    expect(
      check({ update: { rowId: "r1", cells: {} } }, state),
    ).toBeUndefined();
    expect(check({ update: { rowId: "r2", cells: {} } }, state)).toContain(
      "only change the row it's showing",
    );
    expect(check({ update: { rowId: "r1" } }, state)).toContain("cells");
    expect(
      check(
        { update: { rowId: "r1", cells: {}, resources: { "1bad": null } } },
        state,
      ),
    ).toContain("isn't a valid instance name");
  });

  it("hands the view the stored row beside the draft-applied one", () => {
    const stored = { ...row, cells: {} };
    const draft = {
      ...row,
      resources: { task: { uri: "tasks.ts#seededTask" } },
    };
    const props = datasetSurface.props(
      { ...state, context: { selected: { index: 0, row: draft, stored } } },
      () => {},
      {} as never,
    );
    expect(props.selected?.row).toBe(draft);
    expect(props.selected?.stored).toBe(stored);
  });

  it("selects only rows that exist", () => {
    const { check } = datasetSurface.actions.selectRow;
    expect(check({ index: 1 }, state)).toBeUndefined();
    expect(check({ index: 2 }, state)).toBeDefined();
    expect(check({ index: 0.5 }, state)).toBeDefined();
  });

  it("shows only instances the selected row declares", () => {
    const { check } = datasetSurface.actions.showInstance;
    expect(datasetSurface.actions.showInstance.effect).toBe("ephemeral");
    const withInstance = {
      ...state,
      context: {
        selected: {
          index: 0,
          row: {
            ...row,
            resources: { task: { uri: "tasks.ts#seededTask" } },
          },
        },
      },
    };
    expect(check({ name: "task" }, withInstance)).toBeUndefined();
    expect(check({ name: "other" }, withInstance)).toContain("no instance");
    expect(check({ name: "toString" }, withInstance)).toContain("no instance");
    expect(check({ name: "task" }, state)).toContain("no instance");
    expect(check({}, withInstance)).toContain("needs a name");
  });

  it("is never live", () => {
    expect(datasetSurface.isFinal(state.subject)).toBe(true);
    expect(
      datasetView({ applies: () => true, mount: () => ({ update() {} }) }),
    ).toBeDefined();
  });
});
