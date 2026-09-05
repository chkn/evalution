// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import {
  DB_RESOURCE,
  OPAQUE_DB,
  SEEDED_TASK,
  sourcesFor,
  TOOLS_CONTEXT_WITH_NESTED_DB,
} from "./executionFixtures";
import { PlaygroundExecutionHarness } from "./PlaygroundExecutionHarness";

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

test("a slot with matching resources gains a dropdown listing them, plus Custom", async ({
  mount,
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

  const source = component.locator(".pg-slot-source");
  await expect(source).toHaveCount(1);
  // "Custom" is present because the slot is editable: matching offers a
  // resource *beside* the editor, never instead of it.
  await expect(source.locator("option")).toHaveText([
    "Custom",
    SEEDED_TASK.label,
  ]);
  await expect(component.locator("textarea, input").first()).toBeVisible();
});

test("picking a resource replaces the editor with a labelled chip, and it survives a remount", async ({
  mount,
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
  await component.locator(".pg-slot-source").selectOption(SEEDED_TASK.uri);

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
  await expect(hint).toContainText("No value editor for this type");
  await expect(hint.getByRole("link")).toHaveAccessibleName(
    "Learn more about opaque types",
  );
});

test("an opaque slot with a matching resource makes the dropdown its only control", async ({
  mount,
}) => {
  const component = await mount(
    <PlaygroundExecutionHarness
      functionParameters={[OPAQUE_DB]}
      inputSources={sourcesFor({ db: [DB_RESOURCE.uri] }, [DB_RESOURCE])}
    />,
  );

  const source = component.locator(".pg-slot-source");
  // No "Custom": there is no editor to fall back to.
  await expect(source.locator("option")).toHaveText([
    "Choose a resource…",
    DB_RESOURCE.label,
  ]);

  await source.selectOption(DB_RESOURCE.uri);
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
  await expect(hint).toContainText("No value editor for this type");
  await expect(hint.getByRole("link")).toHaveAccessibleName(
    "Learn more about opaque types",
  );
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
