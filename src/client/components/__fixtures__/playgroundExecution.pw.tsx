// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";
import {
  DB_RESOURCE,
  ODIN_TOOLS_CONTEXT,
  OPAQUE_DB,
  odinDbSlots,
  PARAMETERIZED_SEEDED_TASK,
  SEEDED_RUN,
  SEEDED_TASK,
  sourcesFor,
  TASK_A,
  TASK_A_ID,
  TASK_A_INFO,
  TASK_A_TITLE,
  TASK_B,
  TASK_B_ID,
  TASKS_LIBRARY,
  TITLE_GENERATOR,
  TOOLS_CONTEXT_WITH_NESTED_DB,
  WORKSPACE_RESOURCE,
} from "./executionFixtures";
import { PlaygroundExecutionHarness } from "./PlaygroundExecutionHarness";

/**
 * Opens a slot's SourcePicker (its `...` trigger button) and clicks a
 * top-level menu entry by its label — the flat resources this suite mostly
 * deals with never need a submenu. `trigger` scopes to one slot's own
 * trigger when a row has more than one on screen; the menu itself is
 * portal-rendered to `document.body`, so it's found via `page`, not the
 * mounted component's own locator.
 */
async function chooseSource(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function mockExecute(page: Page) {
  await page.route("**/api/**", route =>
    route.fulfill({
      json: { traceId: "t1", tracerProviderId: "p1", rootSpanId: "s1" },
    }),
  );
}

test("surfaces the server's resolution error, now that resolution happens there", async ({
  mount,
  page,
}) => {
  // Inputs are sent unresolved and materialized server-side — which is what
  // lets an import-bound value resolve at all, and what a resource requires.
  // So an unresolvable value fails on the server, and the panel's job is to
  // report it rather than to have caught it itself.
  await page.route("**/api/**", route =>
    route.fulfill({
      status: 500,
      json: { error: "Cannot materialize raw value: doSomething(x)" },
    }),
  );

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "config",
          type: { kind: "primitive", syntax: "unknown" },
          optional: false,
          defaultValue: { kind: "raw", sourceText: "doSomething(x)" },
        },
      ]}
    />,
  );

  await component.getByText("Run").click();

  const error = component.locator(".pg-exec-error");
  await expect(error).toContainText("doSomething(x)");
});

test("a run's error sits in the footer, above the Run button — not in the scrolling body", async ({
  mount,
  page,
}) => {
  // Regression: this error used to render inside `.pg-exec-body`, the same
  // scrolling region as the inputs — so it could scroll out of view right
  // after the button that caused it. It belongs in `.pg-exec-footer`, which
  // doesn't scroll with the rest of the panel, same as the Run button itself.
  await page.route("**/api/**", route =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "notes",
          type: { kind: "primitive", syntax: "string" },
          optional: false,
        },
      ]}
    />,
  );

  await component.locator("textarea, input").first().fill("hello");
  await component.getByText("Run").click();

  const footer = component.locator(".pg-exec-footer");
  const error = footer.locator(".pg-exec-error");
  await expect(error).toBeVisible();
  await expect(component.locator(".pg-exec-body .pg-exec-error")).toHaveCount(
    0,
  );

  // Above the button, not just somewhere in the footer.
  const footerChildren = footer.locator(":scope > *");
  await expect(footerChildren.nth(0)).toHaveClass(/pg-exec-error/);
  await expect(footerChildren.nth(1)).toHaveClass(/pg-run-btn/);
});

test("the run error shadows its top edge while the body has more to scroll to, and stops once it doesn't", async ({
  mount,
  page,
}) => {
  // The error sits in the non-scrolling footer (see the test above), which
  // means nothing on screen otherwise hints that `.pg-exec-body`, right
  // above it, still has unscrolled content — the shadow is that hint, so it
  // should track the body's own scroll position rather than being static.
  await page.route("**/api/**", route =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );

  const fields = Array.from({ length: 8 }, (_, i) => ({
    name: `f${i}`,
    type: { kind: "primitive" as const, syntax: "string" },
    optional: false,
  }));

  // Needs the real wide-layout wrapper (`.pg-content` / `.pg-exec-col`) —
  // `.pg-exec-body` only scrolls independently of the page there; the bare
  // harness's narrow layout has nothing of its own to scroll.
  const component = await mount(
    <div className="pg-playground-wrapper" style={{ width: 900, height: 400 }}>
      <div className="pg-content" style={{ height: "100%" }}>
        <div className="pg-exec-col" style={{ height: "100%" }}>
          <PlaygroundExecutionHarness functionParameters={fields} />
        </div>
      </div>
    </div>,
  );

  const inputs = component.locator("textarea, input");
  const count = await inputs.count();
  for (let i = 0; i < count; i++) await inputs.nth(i).fill("x");
  await component.getByText("Run").click();

  const error = component.locator(".pg-exec-error-run");
  const body = component.locator(".pg-exec-body");

  await body.evaluate(el => {
    el.scrollTop = 0;
  });
  await expect(error).toHaveClass(/pg-exec-error-run-shadow/);

  await body.evaluate(el => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(error).not.toHaveClass(/pg-exec-error-run-shadow/);
});

test("a branded string parameter (e.g. a template-literal ID type) edits as plain text, not JSON", async ({
  mount,
  page,
}) => {
  await mockExecute(page);

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "taskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
      ]}
    />,
  );

  await component.locator("textarea, input").first().fill("tsk_abc123");
  await component.getByText("Run").click();

  // Were this still routed to the JSON fallback editor, the typed text would
  // have been wrapped as an unmaterializable `raw` value and Run would surface
  // an error instead of executing cleanly.
  await expect(component.locator(".pg-exec-error")).toHaveCount(0);
});

test("a string parameter accepts newlines", async ({ mount, page }) => {
  await mockExecute(page);

  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "notes",
          type: { kind: "primitive", syntax: "string" },
          optional: false,
        },
      ]}
    />,
  );

  const field = component.locator("textarea, input").first();
  await field.click();
  await field.pressSequentially("line one");
  await field.press("Enter");
  await field.pressSequentially("line two");

  await expect(field).toHaveValue("line one\nline two");
});

test("execute parameter values persist to localStorage per prompt and restore on remount", async ({
  mount,
}) => {
  const params = [
    {
      name: "note",
      type: { kind: "primitive" as const, syntax: "string" },
      optional: false,
    },
  ];

  const component = await mount(
    <PlaygroundExecutionHarness functionParameters={params} promptId="p1" />,
  );
  await component.locator("textarea, input").first().fill("remember me");
  await component.unmount();

  const remounted = await mount(
    <PlaygroundExecutionHarness functionParameters={params} promptId="p1" />,
  );
  await expect(remounted.locator("textarea, input").first()).toHaveValue(
    "remember me",
  );
});

test("stored parameter values don't leak between different prompts", async ({
  mount,
}) => {
  const params = [
    {
      name: "note",
      type: { kind: "primitive" as const, syntax: "string" },
      optional: false,
    },
  ];

  const component = await mount(
    <PlaygroundExecutionHarness functionParameters={params} promptId="p1" />,
  );
  await component.locator("textarea, input").first().fill("only for p1");
  await component.unmount();

  const other = await mount(
    <PlaygroundExecutionHarness functionParameters={params} promptId="p2" />,
  );
  await expect(other.locator("textarea, input").first()).toHaveValue("");
});

test("a slot with matching resources gains a picker listing them, plus Custom", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "taskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
      ]}
      inputSources={sourcesFor({ taskId: [SEEDED_TASK.uri] }, [SEEDED_TASK])}
    />,
  );

  const trigger = component.locator(".pg-slot-source-wrap");
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  // "Custom" is present because the slot is editable: matching offers a
  // resource *beside* the editor, never instead of it. It's also the current
  // choice (nothing else is picked yet), hence its checkmark.
  await expect(page.getByRole("menuitem")).toHaveText([
    "✓Custom",
    SEEDED_TASK.label,
  ]);
  await page.keyboard.press("Escape");
  await expect(component.locator("textarea, input").first()).toBeVisible();
});

test("picking a resource replaces the editor with a labelled chip, and it survives a remount", async ({
  mount,
  page,
}) => {
  const props = {
    functionParameters: [
      {
        name: "taskId",
        type: {
          kind: "primitive" as const,
          syntax: "TaskId",
          base: "string" as const,
        },
        optional: false,
      },
    ],
    inputSources: sourcesFor({ taskId: [SEEDED_TASK.uri] }, [SEEDED_TASK]),
    promptId: "chip-prompt",
  };

  const component = await mount(<PlaygroundExecutionHarness {...props} />);
  await chooseSource(
    page,
    component.locator(".pg-slot-source-wrap"),
    SEEDED_TASK.label,
  );

  // A resource's value doesn't exist until the run creates it, so there is
  // nothing to seed an editor with — the chip says what will happen instead.
  const chip = component.locator(".pg-slot-chip");
  await expect(chip).toContainText(SEEDED_TASK.label);
  await expect(chip).toContainText("created for each run");
  await expect(component.locator("textarea, input")).toHaveCount(0);

  await component.unmount();
  const remounted = await mount(<PlaygroundExecutionHarness {...props} />);
  await expect(remounted.locator(".pg-slot-chip")).toContainText(
    SEEDED_TASK.label,
  );
});

test("choosing the same resource for a second slot says 'same instance as' on its chip, even with no arguments to share", async ({
  mount,
  page,
}) => {
  // Regression: the "one binding per resource" note used to only exist for
  // a resource with declared arguments — a plain resource (no `parameters`)
  // picked twice showed two identical, unrelated-looking chips with no hint
  // that a run creates it once and reuses it, not twice.
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "taskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
        {
          name: "parentTaskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
      ]}
      inputSources={sourcesFor(
        { taskId: [SEEDED_TASK.uri], parentTaskId: [SEEDED_TASK.uri] },
        [SEEDED_TASK],
      )}
    />,
  );

  const rows = component.locator(".pg-exec-param");
  await chooseSource(
    page,
    rows.nth(0).locator(".pg-slot-source-wrap"),
    SEEDED_TASK.label,
  );
  await chooseSource(
    page,
    rows.nth(1).locator(".pg-slot-source-wrap"),
    SEEDED_TASK.label,
  );

  // The first (owning) selection keeps its normal scope note.
  await expect(rows.nth(0).locator(".pg-slot-chip-note")).toContainText(
    "created for each run",
  );
  // The second names the row it's the same instance as, instead — as a link
  // (a chevron pointing up at it, not the word "above") rather than plain text.
  const note = rows.nth(1).locator(".pg-slot-chip-note");
  await expect(note).toContainText("same instance as");
  await expect(note).not.toContainText("above");
  const link = note.getByRole("button", { name: /taskId/ });
  await expect(link).toContainText("▲");
  await expect(link).toContainText("taskId");
  // Neither row wastes space on an args form — this resource has none.
  await expect(component.locator(".pg-args-form")).toHaveCount(0);
});

test("clicking a 'same instance as' link scrolls to and briefly highlights the row it points at", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "taskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
        {
          name: "parentTaskId",
          type: { kind: "primitive", syntax: "TaskId", base: "string" },
          optional: false,
        },
      ]}
      inputSources={sourcesFor(
        { taskId: [SEEDED_TASK.uri], parentTaskId: [SEEDED_TASK.uri] },
        [SEEDED_TASK],
      )}
    />,
  );

  const rows = component.locator(".pg-exec-param");
  await chooseSource(
    page,
    rows.nth(0).locator(".pg-slot-source-wrap"),
    SEEDED_TASK.label,
  );
  await chooseSource(
    page,
    rows.nth(1).locator(".pg-slot-source-wrap"),
    SEEDED_TASK.label,
  );

  const ownerSlot = rows.nth(0).locator(".pg-slot");
  await expect(ownerSlot).not.toHaveClass(/pg-row-highlight/);

  await rows
    .nth(1)
    .locator(".pg-slot-chip-note")
    .getByRole("button", { name: /taskId/ })
    .click();

  // The owning row (not the one clicked) is the one that flashes.
  await expect(ownerSlot).toHaveClass(/pg-row-highlight/);
  await expect(rows.nth(1).locator(".pg-slot")).not.toHaveClass(
    /pg-row-highlight/,
  );
  // And the flash is temporary, not a lasting state change.
  await expect(ownerSlot).not.toHaveClass(/pg-row-highlight/, {
    timeout: 2000,
  });
});

test("a resource the server already has a value for previews it, read-only, through the slot's own editor", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "workspaceId",
          type: { kind: "primitive", syntax: "WorkspaceId", base: "string" },
          optional: false,
        },
      ]}
      inputSources={sourcesFor({ workspaceId: [WORKSPACE_RESOURCE.uri] }, [
        WORKSPACE_RESOURCE,
      ])}
    />,
  );
  await chooseSource(
    page,
    component.locator(".pg-slot-source-wrap"),
    WORKSPACE_RESOURCE.label,
  );

  // Unlike SEEDED_TASK (run-scoped, no value until Run), the server already
  // knows this one — so the panel shows it, seeded into the same string
  // editor a "Custom" choice would use, rather than just naming it on a chip.
  const preview = component.locator(".pg-slot-preview");
  const field = preview.locator("textarea, input");
  await expect(field).toHaveAttribute("readonly", "");
  await expect(field).toHaveValue(WORKSPACE_RESOURCE.value as string);
  // The chip would be redundant with a real preview on screen.
  await expect(component.locator(".pg-slot-chip")).toHaveCount(0);

  // `readOnly`, unlike the `inert` wrapper this replaced, still lets the
  // value be selected and copied — that's the whole reason for the change.
  await field.dblclick();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .not.toBe("");

  // But it does block editing — typing must leave the value unchanged.
  await field.pressSequentially("nope");
  await expect(field).toHaveValue(WORKSPACE_RESOURCE.value as string);
});

test("an opaque slot with no matching resource shows the hint, not a JSON textarea", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness functionParameters={[OPAQUE_DB]} />,
  );

  // A textarea over a database handle only invites input that can never be
  // right; the panel says so, and points at more detail via the help link.
  // The type itself isn't repeated here — it's already in the slot's own label.
  await expect(component.locator("textarea")).toHaveCount(0);
  await expect(component.locator(".pg-exec-param-type")).toContainText("Db");
  const hint = component.locator(".pg-slot-hint");
  await expect(hint).toContainText("No editor for this type");
  await expect(hint.getByRole("link")).toHaveAccessibleName(
    "Learn more about opaque types",
  );
});

test("an opaque slot with a matching resource makes the picker its only control", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[OPAQUE_DB]}
      inputSources={sourcesFor({ db: [DB_RESOURCE.uri] }, [DB_RESOURCE])}
    />,
  );

  const trigger = component.locator(".pg-slot-source-wrap");
  await trigger.click();
  // No "Custom": there is no editor to fall back to. "Pick a resource…" is a
  // plain placeholder row, not a menuitem — nothing to pick it *from*.
  await expect(
    component.page().locator(".pg-source-menu-placeholder"),
  ).toHaveText("Pick a resource…");
  await expect(page.getByRole("menuitem")).toHaveText([DB_RESOURCE.label]);

  await page.getByRole("menuitem", { name: DB_RESOURCE.label }).click();
  await expect(component.locator(".pg-slot-chip")).toContainText(
    "created once per server",
  );
});

test("a nested opaque slot shows the hint even when no resource is wired to it", async ({
  mount,
}) => {
  // Regression: the nested-slot plugin used to bail out entirely when
  // `slots` had no nested matches at all, which is the common case for a
  // `db`-shaped field nobody has wired a resource to yet. That let such
  // fields fall through to ts-proppy's generic, resource-unaware opaque
  // placeholder instead of this panel's own guidance.
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      executeParameters={[TOOLS_CONTEXT_WITH_NESTED_DB]}
    />,
  );

  const hint = component.locator(".pg-slot-hint");
  await expect(hint).toHaveCount(1);
  await expect(hint).toContainText("No editor for this type");
  await expect(hint.getByRole("link")).toHaveAccessibleName(
    "Learn more about opaque types",
  );
});

test("typing into a nested Custom editor doesn't lose focus after each character", async ({
  mount,
}) => {
  // Regression: the nested-slot plugin's `component` closed over `selection`
  // directly, so it was rebuilt — a brand new function identity — on every
  // keystroke (typing updates `selection.value`). ts-proppy renders a
  // plugin's component by reference, so a new one each keystroke unmounted
  // and remounted the field being typed into, dropping focus after every
  // character. `fill()` doesn't catch this (it sets the whole value in one
  // native-input mutation); only per-character typing does.
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      executeParameters={[
        {
          name: "toolsContext",
          optional: false,
          type: {
            kind: "object",
            syntax: "Ctx",
            properties: [
              {
                name: "list_tasks",
                optional: false,
                type: {
                  kind: "object",
                  syntax: "{ workspaceId: string }",
                  properties: [
                    {
                      name: "workspaceId",
                      optional: false,
                      type: { kind: "primitive", syntax: "string" },
                    },
                  ],
                },
              },
            ],
          },
        },
      ]}
      inputSources={sourcesFor(
        { "toolsContext.list_tasks.workspaceId": [WORKSPACE_RESOURCE.uri] },
        [WORKSPACE_RESOURCE],
        "executeSlots",
      )}
    />,
  );

  const field = component.locator("textarea, input").first();
  await field.click();
  await field.pressSequentially("ws_abc123");
  await expect(field).toHaveValue("ws_abc123");
});

test("a nested opaque field still gets its picker when an ancestor object also matches a resource", async ({
  mount,
}) => {
  // Regression: the nested-slot plugin's `component` recursed into
  // `ItemEditor` without forwarding `plugins`, so once one intermediate node
  // (here, one tool's whole context object — the same shape as a resource
  // that happens to produce exactly `{ db, workspaceId }`) matched a resource
  // and rendered through the plugin, everything *beneath* it fell back to
  // ts-proppy's own generic, resource-unaware editors — silently dropping the
  // picker on a nested `db` field one level deeper.
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      executeParameters={[
        {
          name: "toolsContext",
          optional: false,
          type: {
            kind: "object",
            syntax: "Ctx",
            properties: [
              {
                name: "update_task",
                optional: false,
                type: {
                  kind: "object",
                  syntax: "{ db: Db; workspaceId: WorkspaceId }",
                  properties: [
                    {
                      name: "db",
                      optional: false,
                      type: { kind: "opaque", syntax: "Db" },
                    },
                    {
                      name: "workspaceId",
                      optional: false,
                      type: {
                        kind: "primitive",
                        syntax: "WorkspaceId",
                        base: "string",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ]}
      inputSources={sourcesFor(
        {
          // The whole `update_task` context matches too — its own resource
          // happens to produce exactly `{ db, workspaceId }`.
          "toolsContext.update_task": [DB_RESOURCE.uri],
          "toolsContext.update_task.db": [DB_RESOURCE.uri],
        },
        [DB_RESOURCE],
        "executeSlots",
      )}
    />,
  );

  // Ts-proppy's own generic opaque placeholder must never appear here — it's
  // what a nested `db` field falls back to when it lost its picker.
  await expect(component.locator('[data-proppy-editor="opaque"]')).toHaveCount(
    0,
  );
  // One picker for the whole `update_task` object, one for its nested `db`.
  await expect(component.locator(".pg-slot-source-wrap")).toHaveCount(2);
});

test("execute parameters render in their own section, after a divider", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[
        {
          name: "notes",
          type: { kind: "primitive", syntax: "string" },
          optional: false,
        },
      ]}
      executeParameters={[
        {
          name: "toolsContext",
          type: { kind: "opaque", syntax: "InferToolSetContext<typeof tools>" },
          optional: false,
        },
      ]}
    />,
  );

  // "What does this prompt take?" and "what does running it require?" are
  // different questions, so the panel keeps them visibly apart with a divider
  // — unlabeled, since the params either side of it already say enough.
  const labels = component.locator(".pg-exec-param-label, .pg-exec-section");
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(0)).toContainText("notes");
  await expect(labels.nth(1)).toBeEmpty();
  await expect(labels.nth(2)).toContainText("toolsContext");
});

test("a broken playground module is reported rather than silently absent", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      inputSources={{
        resources: [
          {
            uri: ".evalution/playground/db.ts",
            label: "db.ts",
            scope: "run",
            error: "Cannot find module 'miniflare'",
          },
        ],
        functionSlots: {},
        executeSlots: {},
      }}
    />,
  );

  await expect(component.locator(".pg-exec-error")).toContainText("miniflare");
});

test("a fan-out slot's combined mode renders one row per group, each labelled with its members", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      executeParameters={[ODIN_TOOLS_CONTEXT]}
    />,
  );

  await component.getByRole("tab", { name: "Combined" }).click();

  const rows = component.locator(".pg-combined-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("db");
  await expect(rows.nth(0)).toContainText("all 4");
  await expect(rows.nth(1)).toContainText("workspaceId");
  await expect(rows.nth(1)).toContainText("all 4");
  await expect(rows.nth(2)).toContainText("rootTaskId");
  await expect(rows.nth(2)).toContainText("list_tasks, create_task");
  await expect(rows.nth(3)).toContainText("runId");
  await expect(rows.nth(3)).toContainText("post_message");
});

test("choosing a resource on a combined row fans it out to every member, visible after switching to expanded", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      executeParameters={[ODIN_TOOLS_CONTEXT]}
      inputSources={{
        resources: [DB_RESOURCE],
        functionSlots: {},
        executeSlots: odinDbSlots(DB_RESOURCE),
      }}
    />,
  );

  await component.getByRole("tab", { name: "Combined" }).click();
  const dbRow = component.locator(".pg-combined-row").first();
  await chooseSource(
    page,
    dbRow.locator(".pg-slot-source-wrap"),
    DB_RESOURCE.label,
  );
  await expect(dbRow.locator(".pg-slot-chip")).toContainText(DB_RESOURCE.label);

  await component.getByRole("tab", { name: "Expanded" }).click();
  // Each member is its own collapsible section (ts-proppy collapses a nested
  // object by default once there's more than one sibling) — expand all four
  // before looking for their chips, same as a user would.
  for (const name of [
    "list_tasks",
    "create_task",
    "update_task",
    "post_message",
  ]) {
    await component.getByRole("button", { name: `Expand ${name}` }).click();
  }

  const chips = component.locator(".pg-slot-chip");
  await expect(chips).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(chips.nth(i)).toContainText(DB_RESOURCE.label);
  }
});

test("typing into a combined row persists as the expanded form and restores it, combined, on remount", async ({
  mount,
}) => {
  const props = {
    functionParameters: [],
    executeParameters: [ODIN_TOOLS_CONTEXT],
    promptId: "combined-prompt",
  };

  const component = await mount(<PlaygroundExecutionHarness {...props} />);
  await component.getByRole("tab", { name: "Combined" }).click();
  const workspaceRow = component.locator(".pg-combined-row").nth(1);
  await workspaceRow
    .locator("textarea, input")
    .first()
    .fill("ws_internal_default");
  await component.unmount();

  const remounted = await mount(<PlaygroundExecutionHarness {...props} />);
  // The layout choice is the user's explicit one, so it's stored too and
  // reopens combined rather than falling back to the default.
  await expect(remounted.locator(".pg-combined-row")).toHaveCount(4);
  await expect(
    remounted
      .locator(".pg-combined-row")
      .nth(1)
      .locator("textarea, input")
      .first(),
  ).toHaveValue("ws_internal_default");
});

test("the layout toggle is absent for a slot with only one member", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[]}
      executeParameters={[TOOLS_CONTEXT_WITH_NESTED_DB]}
    />,
  );

  await expect(component.locator(".pg-layout-tabs")).toHaveCount(0);
});

test.describe("SourcePicker (specs/resource-hierarchy.md §E)", () => {
  const taskRefSlot = {
    name: "taskRef",
    type: { kind: "primitive" as const, syntax: "string" },
    optional: false,
  };

  /** The "Tasks" library, offered on one editable slot. */
  function taskRefHarness(promptId?: string) {
    return (
      <PlaygroundExecutionHarness
        functionParameters={[taskRefSlot]}
        promptId={promptId}
        inputSources={{
          resources: TASKS_LIBRARY,
          functionSlots: {
            taskRef: [
              TASK_A_ID.uri,
              TASK_A_TITLE.uri,
              TASK_A_INFO.uri,
              TASK_B_ID.uri,
            ],
          },
          executeSlots: {},
        }}
      />
    );
  }

  test("opens a nested menu, not a native <select>", async ({
    mount,
    page,
  }) => {
    const component = await mount(taskRefHarness());

    await expect(component.locator("select")).toHaveCount(0);
    await component.locator(".pg-slot-source-wrap").click();
    await expect(page.locator(".pg-source-menu-root")).toBeVisible();
    // The two tasks are one group's worth of menu, not four flat entries.
    await expect(page.getByRole("menuitem", { name: "Tasks" })).toBeVisible();
  });

  test("hovering Tasks opens a submenu, and hovering Task A opens its own values", async ({
    mount,
    page,
  }) => {
    const component = await mount(taskRefHarness());
    await component.locator(".pg-slot-source-wrap").click();

    await page.getByRole("menuitem", { name: "Tasks" }).hover();
    // Task B has only one matching value (`siblings === 1`), so it collapses
    // to a "Resource → Value" row rather than opening a one-item submenu of
    // its own.
    await expect(
      page.getByRole("menuitem", { name: TASK_A.label, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: `${TASK_B.label} → ${TASK_B_ID.label}`,
        exact: true,
      }),
    ).toBeVisible();

    await page
      .getByRole("menuitem", { name: TASK_A.label, exact: true })
      .hover();
    await expect(
      page.getByRole("menuitem", { name: TASK_A_ID.label, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: TASK_A_TITLE.label, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: TASK_A_INFO.label, exact: true }),
    ).toBeVisible();
  });

  test("choosing Task ID shows the chip labelled 'Resource → Output', and round-trips through localStorage", async ({
    mount,
    page,
  }) => {
    const component = await mount(taskRefHarness("task-picker-prompt"));
    await component.locator(".pg-slot-source-wrap").click();
    await page.getByRole("menuitem", { name: "Tasks" }).hover();
    await page
      .getByRole("menuitem", { name: TASK_A.label, exact: true })
      .hover();
    await page
      .getByRole("menuitem", { name: TASK_A_ID.label, exact: true })
      .click();

    // Task A has three matching outputs, so the dropdown row that chose this
    // one was itself labelled `"${TASK_A.label} → ${TASK_A_ID.label}"` — the
    // chip repeats that same composite, arrow and all, now that the tree
    // (and its breadcrumb) is no longer on screen to say which task this is.
    const chip = component.locator(".pg-slot-chip");
    await expect(chip).toHaveText(
      `${TASK_A.label} → ${TASK_A_ID.label}created for each run`,
    );
    await expect(component.locator("textarea, input")).toHaveCount(0);

    await component.unmount();
    const remounted = await mount(taskRefHarness("task-picker-prompt"));
    await expect(remounted.locator(".pg-slot-chip")).toContainText(
      `${TASK_A.label} → ${TASK_A_ID.label}`,
    );
  });

  test("Task B's collapsed entry is a leaf — clicking it chooses directly, with no submenu to open first", async ({
    mount,
    page,
  }) => {
    const component = await mount(taskRefHarness());
    await component.locator(".pg-slot-source-wrap").click();
    await page.getByRole("menuitem", { name: "Tasks" }).hover();

    // The row itself is labelled "Resource → Value" (its one declared value
    // collapsed the submenu away, same as Task A's narrowed-down one did) —
    // and it's still that value being chosen underneath, so the chip
    // afterward names the same pair.
    const taskBRow = page.getByRole("menuitem", {
      name: `${TASK_B.label} → ${TASK_B_ID.label}`,
      exact: true,
    });
    await expect(taskBRow).not.toHaveAttribute("aria-haspopup", "menu");
    await taskBRow.click();

    await expect(component.locator(".pg-slot-chip")).toHaveText(
      `${TASK_B.label} → ${TASK_B_ID.label}created for each run`,
    );
  });

  test("keyboard traversal reaches a depth-3 entry, and ← returns to Task A's row", async ({
    mount,
    page,
  }) => {
    const component = await mount(taskRefHarness());
    await component.locator(".pg-slot-source-wrap").click();

    // Custom, then Tasks — one ArrowDown from the auto-focused first row.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Tasks" })).toBeFocused();

    // → opens the Tasks submenu, focusing its first row (Task A).
    await page.keyboard.press("ArrowRight");
    const taskARow = page.getByRole("menuitem", {
      name: TASK_A.label,
      exact: true,
    });
    await expect(taskARow).toBeFocused();

    // → again opens Task A's own submenu — a third menu level.
    await page.keyboard.press("ArrowRight");
    const taskIdRow = page.getByRole("menuitem", {
      name: TASK_A_ID.label,
      exact: true,
    });
    await expect(taskIdRow).toBeVisible();
    await expect(taskIdRow).toBeFocused();

    // ← closes that third level and returns focus to Task A's own row.
    await page.keyboard.press("ArrowLeft");
    await expect(taskIdRow).not.toBeVisible();
    await expect(taskARow).toBeFocused();
  });

  test("the menu portals to the document body, so a scrolling sidebar can never clip it", async ({
    mount,
    page,
  }) => {
    const component = await mount(taskRefHarness());
    await component.locator(".pg-slot-source-wrap").click();

    const menu = page.locator(".pg-source-menu-root");
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(el => el.parentElement === document.body)).toBe(
      true,
    );
  });

  test("stays fully inside the viewport when its trigger sits near the right edge", async ({
    mount,
    page,
  }) => {
    // Regression: the root menu used to anchor only its left edge to the
    // trigger and size itself to content, with no awareness of the viewport
    // — a trigger near the right edge (the execute panel's own right column
    // is exactly this) pushed the menu off-screen, unreadable.
    await page.setViewportSize({ width: 400, height: 700 });
    const component = await mount(taskRefHarness());
    await component.locator(".pg-slot-source-wrap").click();

    const menu = page.locator(".pg-source-menu-root");
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(400);
  });
});

test.describe("resource arguments (specs/resource-arguments.md §I, §J)", () => {
  test("choosing a parameterized resource reveals its argument form", async ({
    mount,
    page,
  }) => {
    const component = await mount(
      <PlaygroundExecutionHarness
        functionParameters={[
          {
            name: "taskId",
            type: { kind: "primitive", syntax: "TaskId", base: "string" },
            optional: false,
          },
        ]}
        inputSources={sourcesFor({ taskId: [PARAMETERIZED_SEEDED_TASK.uri] }, [
          PARAMETERIZED_SEEDED_TASK,
          TITLE_GENERATOR,
        ])}
      />,
    );

    await expect(component.locator(".pg-args-form")).toHaveCount(0);
    await chooseSource(
      page,
      component.locator(".pg-slot-source-wrap"),
      PARAMETERIZED_SEEDED_TASK.label,
    );

    const form = component.locator(".pg-args-form").first();
    await expect(form).toBeVisible();
    await expect(form.locator(".pg-args-name")).toHaveText(["title", "status"]);
  });

  test("a resource with no arguments shows no form", async ({
    mount,
    page,
  }) => {
    const component = await mount(
      <PlaygroundExecutionHarness
        functionParameters={[
          {
            name: "taskId",
            type: { kind: "primitive", syntax: "TaskId", base: "string" },
            optional: false,
          },
        ]}
        inputSources={sourcesFor({ taskId: [SEEDED_TASK.uri] }, [SEEDED_TASK])}
      />,
    );
    await chooseSource(
      page,
      component.locator(".pg-slot-source-wrap"),
      SEEDED_TASK.label,
    );
    await expect(component.locator(".pg-slot-chip")).toContainText(
      SEEDED_TASK.label,
    );
    await expect(component.locator(".pg-args-form")).toHaveCount(0);
  });

  test("typing into the argument form persists to localStorage and restores on remount", async ({
    mount,
    page,
  }) => {
    const props = {
      functionParameters: [
        {
          name: "taskId",
          type: {
            kind: "primitive" as const,
            syntax: "TaskId",
            base: "string" as const,
          },
          optional: false,
        },
      ],
      inputSources: sourcesFor({ taskId: [PARAMETERIZED_SEEDED_TASK.uri] }, [
        PARAMETERIZED_SEEDED_TASK,
        TITLE_GENERATOR,
      ]),
      promptId: "args-persist-prompt",
    };

    const component = await mount(<PlaygroundExecutionHarness {...props} />);
    await chooseSource(
      page,
      component.locator(".pg-slot-source-wrap"),
      PARAMETERIZED_SEEDED_TASK.label,
    );

    const form = component.locator(".pg-args-form").first();
    const titleField = form.locator("textarea, input").first();
    await titleField.fill("Todo app");
    await form.locator("select").selectOption("open");
    await expect(titleField).toHaveValue("Todo app");

    await component.unmount();
    const remounted = await mount(<PlaygroundExecutionHarness {...props} />);
    const remountedForm = remounted.locator(".pg-args-form").first();
    await expect(remountedForm.locator("textarea, input").first()).toHaveValue(
      "Todo app",
    );
    await expect(remountedForm.locator("select")).toHaveValue("open");
  });

  test("choosing the same resource for a second slot marks its chip 'same instance as' instead of repeating the form", async ({
    mount,
    page,
  }) => {
    const component = await mount(
      <PlaygroundExecutionHarness
        functionParameters={[
          {
            name: "taskId",
            type: { kind: "primitive", syntax: "TaskId", base: "string" },
            optional: false,
          },
          {
            name: "taskTitle",
            type: { kind: "primitive", syntax: "string", base: "string" },
            optional: false,
          },
        ]}
        inputSources={sourcesFor(
          {
            taskId: [PARAMETERIZED_SEEDED_TASK.uri],
            taskTitle: [PARAMETERIZED_SEEDED_TASK.uri],
          },
          [PARAMETERIZED_SEEDED_TASK, TITLE_GENERATOR],
        )}
      />,
    );

    const rows = component.locator(".pg-exec-param");
    await chooseSource(
      page,
      rows.nth(0).locator(".pg-slot-source-wrap"),
      PARAMETERIZED_SEEDED_TASK.label,
    );
    const firstForm = rows.nth(0).locator(".pg-args-form").first();
    await firstForm.locator("textarea, input").first().fill("Shared title");

    await chooseSource(
      page,
      rows.nth(1).locator(".pg-slot-source-wrap"),
      PARAMETERIZED_SEEDED_TASK.label,
    );

    // The second selection doesn't get its own editable form — its chip
    // says it's the same instance as the row that owns it, and that's it:
    // no form, no extra vertical space for one.
    const note = rows.nth(1).locator(".pg-slot-chip-note");
    await expect(note).toContainText("same instance as");
    await expect(note.getByRole("button", { name: /taskId/ })).toBeVisible();
    await expect(rows.nth(1).locator(".pg-args-form")).toHaveCount(0);
    // The first row's own value is untouched by the second selection.
    await expect(firstForm.locator("textarea, input").first()).toHaveValue(
      "Shared title",
    );
  });

  test("the nested title argument offers Title generator as a source, and picking it shows a chip", async ({
    mount,
    page,
  }) => {
    const component = await mount(
      <PlaygroundExecutionHarness
        functionParameters={[
          {
            name: "taskId",
            type: { kind: "primitive", syntax: "TaskId", base: "string" },
            optional: false,
          },
        ]}
        inputSources={sourcesFor(
          { taskId: [PARAMETERIZED_SEEDED_TASK.uri] },
          [PARAMETERIZED_SEEDED_TASK, TITLE_GENERATOR],
          "functionSlots",
          { [PARAMETERIZED_SEEDED_TASK.uri]: { title: [TITLE_GENERATOR.uri] } },
        )}
      />,
    );
    await chooseSource(
      page,
      component.locator(".pg-slot-source-wrap"),
      PARAMETERIZED_SEEDED_TASK.label,
    );

    const form = component.locator(".pg-args-form").first();
    const titleTrigger = form.locator(".pg-slot-source-wrap").first();
    await expect(titleTrigger).toBeVisible();
    await chooseSource(page, titleTrigger, TITLE_GENERATOR.label);
    await expect(form.locator(".pg-slot-chip").first()).toContainText(
      TITLE_GENERATOR.label,
    );
  });

  test("a prompt's own taskId slot and a different resource's own taskId argument don't collide just because they share a name", async ({
    mount,
    page,
  }) => {
    // Regression: `SEEDED_RUN`'s own argument happens to be named `taskId`,
    // the same as the prompt's own top-level parameter — the bare-name
    // ownership check this replaced treated those as the same row, showing
    // the form under *both* instead of one owning it and the other pointing
    // back. See `ResourceArgsContext.path`.
    const component = await mount(
      <PlaygroundExecutionHarness
        functionParameters={[
          {
            name: "taskId",
            type: { kind: "primitive", syntax: "TaskId", base: "string" },
            optional: false,
          },
          {
            name: "run",
            type: { kind: "opaque", syntax: "SeededRun" },
            optional: false,
          },
        ]}
        inputSources={sourcesFor(
          {
            taskId: [PARAMETERIZED_SEEDED_TASK.uri],
            run: [SEEDED_RUN.uri],
          },
          [PARAMETERIZED_SEEDED_TASK, SEEDED_RUN],
          "functionSlots",
          {
            [SEEDED_RUN.uri]: { taskId: [PARAMETERIZED_SEEDED_TASK.uri] },
          },
        )}
      />,
    );

    const rows = component.locator(".pg-exec-param");
    // Select seededTask for the prompt's own taskId slot first.
    await chooseSource(
      page,
      rows.nth(0).locator(".pg-slot-source-wrap"),
      PARAMETERIZED_SEEDED_TASK.label,
    );
    // Then select seededRun for `run`, and seededTask again for *its* own
    // `taskId` argument.
    await chooseSource(
      page,
      rows.nth(1).locator(".pg-slot-source-wrap"),
      SEEDED_RUN.label,
    );
    const runForm = rows.nth(1).locator(".pg-args-form").first();
    await chooseSource(
      page,
      runForm.locator(".pg-slot-source-wrap").first(),
      PARAMETERIZED_SEEDED_TASK.label,
    );

    // Exactly one editable seededTask form exists (title + status) — the
    // prompt's own taskId slot owns it.
    await expect(rows.nth(0).locator(".pg-args-form .pg-args-name")).toHaveText(
      ["title", "status"],
    );
    // seededRun's own row shows only its own argument ("taskId"), whose chip
    // says it's the same instance as the prompt's own taskId row — not a
    // second title/status form nested inside it.
    await expect(rows.nth(1).locator(".pg-args-name")).toHaveText(["taskId"]);
    const nestedNote = runForm.locator(".pg-slot-chip-note");
    await expect(nestedNote).toContainText("same instance as");
    await expect(
      nestedNote.getByRole("button", { name: /taskId/ }),
    ).toBeVisible();
  });
});
