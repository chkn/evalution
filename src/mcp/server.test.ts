// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { trace } from "@opentelemetry/api";
import { connect, type Database } from "@tursodatabase/sync";
import { drizzle } from "drizzle-orm/tursodatabase-sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDatasetMigrations } from "../dataset/db/migrate.ts";
import { TursoDatasetProvider } from "../dataset/turso-dataset-provider.ts";
import { runEvalMigrations } from "../eval/db/migrate.ts";
import { TursoEvalProvider } from "../eval/turso-eval-provider.ts";
import { type PromptProvider, promptIdOf } from "../prompt/prompt-provider.ts";
import { PromptRegistry } from "../prompt/prompt-registry.ts";
import { createApiContext } from "../server/api-context.ts";
import type { NormalizedPrompt } from "../shared/types.ts";
import { runMigrations } from "../trace/db/migrate.ts";
import { TursoTraceProvider } from "../trace/turso-trace-provider.ts";
import { createMcpServer } from "./server.ts";

const clients: Database[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function memoryClient(): Promise<Database> {
  const client = await connect({ path: ":memory:", url: () => null });
  await client.exec("PRAGMA foreign_keys = ON");
  clients.push(client);
  return client;
}

const GREET: NormalizedPrompt = {
  id: "src/greet.prompt.ts#greet",
  globalId: "greet",
  name: "greet",
  style: "chat",
  functionParameters: [
    {
      name: "name",
      optional: false,
      type: { kind: "primitive", syntax: "string", base: "string" },
    },
    {
      name: "excited",
      optional: true,
      type: { kind: "primitive", syntax: "boolean", base: "boolean" },
    },
  ],
  model: {
    kind: "functionCall",
    callee: "openai",
    args: [{ kind: "primitive", value: "gpt-4o" }],
  },
  modelEditable: true,
  modelParameters: [
    {
      def: {
        name: "temperature",
        optional: true,
        type: { kind: "primitive", syntax: "number" },
      },
      value: { kind: "primitive", value: 0.2 },
    },
  ],
  systemEditable: true,
  messages: [],
  messagesEditable: true,
};

/**
 * A fake prompt provider whose `execute` records an LLM span answering
 * "Hello, <name>!" onto `traces`, then settles.
 */
function fakePromptProvider(traces: TursoTraceProvider): PromptProvider {
  return {
    id: "files",
    async getAllPrompts() {
      return [GREET];
    },
    async getPrompt(ref) {
      return promptIdOf(ref) === GREET.id ? GREET : null;
    },
    getSourcePath: prompt =>
      prompt.id === GREET.id ? "/project/src/greet.prompt.ts" : undefined,
    async execute(_ref, params, options) {
      const traceId = options?.traceId as string;
      const span = {
        id: `${traceId}:root`,
        traceId,
        name: "greet",
        kind: "LLM" as const,
        startTime: 1000,
      };
      await traces.recordSpanStart(span);
      // Finishes after `execute` returns, as a real run does.
      setTimeout(async () => {
        await traces.recordSpanEnd({
          ...span,
          endTime: 1250,
          status: "ok",
          llm: {
            model: "gpt-4o",
            output: `Hello, ${params[0]}${params[1] ? "!" : "."}`,
            promptTokens: 7,
            completionTokens: 3,
          },
        });
        options?.onSettled?.();
      }, 10);
    },
  };
}

async function setup(clientName = "claude-code") {
  const traceClient = await memoryClient();
  await runMigrations(drizzle({ client: traceClient }));
  const traces = new TursoTraceProvider({ client: traceClient, id: "local" });
  const datasetClient = await memoryClient();
  await runDatasetMigrations(drizzle({ client: datasetClient }));
  const datasets = new TursoDatasetProvider({
    client: datasetClient,
    id: "local-datasets",
  });
  const evalClient = await memoryClient();
  await runEvalMigrations(drizzle({ client: evalClient }));
  const evals = new TursoEvalProvider({ client: evalClient, id: "evals" });
  const prompts = fakePromptProvider(traces);
  const promptProviders = new Map([[prompts.id, prompts]]);
  const promptRegistry = new PromptRegistry();
  await promptRegistry.rebuild(promptProviders);

  const context = createApiContext({
    promptProviders,
    traceProviders: new Map([[traces.id, traces]]),
    datasetProviders: new Map([[datasets.id, datasets]]),
    evalProviders: new Map([[evals.id, evals]]),
    promptRegistry,
    rootPath: "/project",
    tracer: trace.getTracer("test"),
    defaultTraceProviderId: traces.id,
  });
  const server = createMcpServer(context, { version: "0.0.0-test" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(clientTransport);

  /** Calls a tool, returning its parsed JSON (or text) result; throws on a tool error. */
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    if (result.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return { client, call, traces, datasets };
}

describe("MCP server", () => {
  it("lists the tools the API offers", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      "add_field",
      "add_rows",
      "cancel_eval_run",
      "create_annotation",
      "create_dataset",
      "create_eval",
      "delete_annotation",
      "delete_dataset",
      "delete_eval",
      "delete_eval_run",
      "delete_field",
      "delete_rows",
      "execute_prompt",
      "get_dataset",
      "get_eval",
      "get_eval_run",
      "get_prompt",
      "get_trace_schema",
      "get_traces",
      "list_annotations",
      "list_checks",
      "list_dataset_rows",
      "list_datasets",
      "list_eval_runs",
      "list_evals",
      "list_prompts",
      "list_traces",
      "query_dataset_rows",
      "query_traces",
      "rename_dataset",
      "rename_field",
      "start_eval_run",
      "update_annotation",
      "update_eval",
      "update_rows",
    ]);
  });

  describe("prompts", () => {
    it("lists prompts with their source file, model, and parameters", async () => {
      const { call } = await setup();
      expect(await call("list_prompts")).toEqual([
        {
          providerId: "files",
          id: GREET.id,
          name: "greet",
          globalId: "greet",
          style: "chat",
          sourcePath: "/project/src/greet.prompt.ts",
          model: 'openai("gpt-4o")',
          functionParameters: [
            { name: "name", type: "string", optional: false },
            { name: "excited", type: "boolean", optional: true },
          ],
          modelParameters: { temperature: "0.2" },
        },
      ]);
    });

    it("gets a prompt by id or globalId", async () => {
      const { call } = await setup();
      expect((await call("get_prompt", { promptId: "greet" })).id).toBe(
        GREET.id,
      );
      await expect(call("get_prompt", { promptId: "nope" })).rejects.toThrow(
        "Prompt not found: nope",
      );
    });

    it("runs a prompt with plain JSON arguments and waits for its output", async () => {
      const { call, traces } = await setup();
      const run = await call("execute_prompt", {
        promptId: "greet",
        args: ["Ada", true],
      });
      expect(run).toMatchObject({
        traceProviderId: "local",
        status: "ok",
        output: "Hello, Ada!",
        totalTokens: 10,
        durationMs: 250,
        spanCount: 1,
      });
      expect((await traces.getTrace(run.traceId))?.trace.status).toBe("ok");
    });

    it("returns at once when told not to wait", async () => {
      const { call, traces } = await setup();
      const run = await call("execute_prompt", {
        promptId: GREET.id,
        args: ["Ada"],
        wait: false,
      });
      expect(run.status).toBe("running");
      // The run carries on, and finishes, in the background.
      await vi.waitFor(async () =>
        expect((await traces.getTrace(run.traceId))?.trace.status).toBe("ok"),
      );
    });
  });

  describe("traces", () => {
    async function withRuns() {
      const env = await setup();
      const a = await env.call("execute_prompt", {
        promptId: "greet",
        args: ["Ada"],
      });
      const b = await env.call("execute_prompt", {
        promptId: "greet",
        args: ["Grace", true],
      });
      return { ...env, a, b };
    }

    it("lists traces, newest first, paged", async () => {
      const { call, a, b } = await withRuns();
      const all = await call("list_traces");
      expect(all.total).toBe(2);
      expect(all.traces.map((t: { id: string }) => t.id).sort()).toEqual(
        [a.traceId, b.traceId].sort(),
      );
      expect((await call("list_traces", { limit: 1 })).traces).toHaveLength(1);
    });

    it("serves the schema as a tool and a resource, and queries with SQL", async () => {
      const { call, client, b } = await withRuns();
      const schema = await call("get_trace_schema");
      expect(schema).toContain("CREATE TABLE spans");
      const resource = await client.readResource({
        uri: "evalution://trace-providers/local/schema",
      });
      expect((resource.contents[0] as { text: string }).text).toBe(schema);

      const result = await call("query_traces", {
        sql: "SELECT trace_id, json_extract(llm_output, '$') AS output FROM spans WHERE llm_output LIKE '%Grace%'",
      });
      expect(result).toEqual({
        columns: ["trace_id", "output"],
        rows: [{ trace_id: b.traceId, output: "Hello, Grace!" }],
      });
      await expect(
        call("query_traces", { sql: "DELETE FROM traces" }),
      ).rejects.toThrow();
    });

    it("gets several traces with spans and annotations, reporting unknown ones", async () => {
      const { call, a, b } = await withRuns();
      await call("create_annotation", {
        traceId: a.traceId,
        kind: "good",
        note: "Polite",
      });
      const got = await call("get_traces", {
        traceIds: [a.traceId, b.traceId, "nope"],
      });
      expect(got[0].trace.id).toBe(a.traceId);
      expect(got[0].spans[0].llm.output).toBe("Hello, Ada.");
      expect(got[0].annotations).toMatchObject([
        { kind: "good", note: "Polite", source: "claude-code" },
      ]);
      expect(got[1].annotations).toEqual([]);
      expect(got[2]).toEqual({ id: "nope", error: "Trace not found" });
    });
  });

  describe("annotations", () => {
    it("creates, lists, updates, and deletes annotations", async () => {
      const { call } = await setup();
      const run = await call("execute_prompt", {
        promptId: "greet",
        args: ["Ada"],
      });
      const created = await call("create_annotation", {
        traceId: run.traceId,
        spanId: `${run.traceId}:root`,
        kind: "issue",
        note: "Too terse",
      });
      expect(created).toMatchObject({
        traceId: run.traceId,
        spanId: `${run.traceId}:root`,
        kind: "issue",
        note: "Too terse",
        source: "claude-code",
      });

      const updated = await call("update_annotation", {
        traceId: run.traceId,
        annotationId: created.id,
        note: "Way too terse",
      });
      expect(updated).toEqual({ ...created, note: "Way too terse" });
      expect(await call("list_annotations", { traceId: run.traceId })).toEqual([
        updated,
      ]);

      await call("delete_annotation", {
        traceId: run.traceId,
        annotationId: created.id,
      });
      expect(await call("list_annotations", { traceId: run.traceId })).toEqual(
        [],
      );
      await expect(
        call("update_annotation", {
          traceId: run.traceId,
          annotationId: created.id,
          note: "x",
        }),
      ).rejects.toThrow("Annotation not found");
    });

    it("attributes annotations to Codex when Codex is the client", async () => {
      const { call } = await setup("codex-mcp-client");
      const run = await call("execute_prompt", {
        promptId: "greet",
        args: ["Ada"],
      });
      const created = await call("create_annotation", {
        traceId: run.traceId,
        kind: "note",
        note: "Hi",
      });
      expect(created.source).toBe("codex");
    });
  });

  describe("datasets", () => {
    it("creates a dataset from a prompt, bulk inserts rows by field name, and queries them with SQL", async () => {
      const { call } = await setup();
      const dataset = await call("create_dataset", {
        name: "Greetings",
        fromPrompt: { promptId: "greet" },
        fields: [{ name: "expected", type: "string" }],
      });
      expect(dataset.prompt).toEqual({ id: GREET.id, providerId: "files" });
      expect(
        dataset.fields.map((f: { def: { name: string } }) => f.def.name),
      ).toEqual(["name", "excited", "expected"]);

      const added = await call("add_rows", {
        datasetId: dataset.id,
        rows: [
          { values: { name: "Ada", excited: true, expected: "Hello, Ada!" } },
          { values: { name: "Grace", excited: false } },
          { values: { name: "Linus" } },
        ],
      });
      expect(added.added).toBe(3);

      const got = await call("get_dataset", { datasetId: dataset.id });
      expect(got.rowCount).toBe(3);
      expect(got.fields).toEqual([
        { id: "0", name: "name", type: "string" },
        { id: "1", name: "excited", type: "boolean" },
        { id: "2", name: "expected", type: "string" },
      ]);
      expect(got.queryColumns.map((c: { column: string }) => c.column)).toEqual(
        [
          "_id",
          "_created_at",
          "_source",
          "_cells",
          "name",
          "excited",
          "expected",
        ],
      );

      expect(
        await call("query_dataset_rows", {
          datasetId: dataset.id,
          sql: "SELECT name FROM rows WHERE excited = 1 OR expected IS NULL ORDER BY name",
        }),
      ).toEqual({
        columns: ["name"],
        rows: [{ name: "Ada" }, { name: "Grace" }, { name: "Linus" }],
      });

      const rows = await call("list_dataset_rows", {
        datasetId: dataset.id,
        limit: 2,
      });
      expect(rows.map((r: { values: unknown }) => r.values)).toEqual([
        { name: "Ada", excited: true, expected: "Hello, Ada!" },
        { name: "Grace", excited: false },
      ]);
      expect(rows[0].id).toBe(added.rowIds[0]);
    });

    it("copies a field from a prompt parameter named by its globalId", async () => {
      const { call } = await setup();
      const dataset = await call("create_dataset", {
        name: "From global",
        fields: [
          { from: { providerId: "files", promptId: "greet", path: "name" } },
        ],
      });
      expect(
        (await call("get_dataset", { datasetId: dataset.id })).fields,
      ).toEqual([{ id: "0", name: "name", type: "string" }]);

      const added = await call("add_field", {
        datasetId: dataset.id,
        field: {
          from: { providerId: "files", promptId: "greet", path: "excited" },
        },
      });
      expect(added.id).toBe("1");
    });

    it("sets resource cells and row resources with update_rows, as add_rows does", async () => {
      const { call, datasets } = await setup();
      const dataset = await call("create_dataset", {
        name: "Resources",
        fields: [
          { name: "title", type: "string" },
          { name: "notes", type: "string" },
        ],
      });
      const { rowIds } = await call("add_rows", {
        datasetId: dataset.id,
        rows: [{ values: { title: "Milk" } }],
      });
      const notes = {
        uri: "src/fixtures.ts#notes",
        args: {
          title: { kind: "value", value: { kind: "primitive", value: "Milk" } },
        },
      };
      const resource = { kind: "instance", name: "notes" };
      await call("update_rows", {
        datasetId: dataset.id,
        updates: [
          {
            rowId: rowIds[0],
            cells: { title: resource, notes: resource },
            resources: { notes },
          },
        ],
      });
      const [row] = await datasets.listRows(dataset.id);
      expect(row.cells).toEqual({ "0": resource, "1": resource });
      expect(row.resources).toEqual({ notes });
    });

    it("updates and deletes rows, and renames and deletes fields", async () => {
      const { call } = await setup();
      const dataset = await call("create_dataset", {
        name: "Edit",
        fields: [
          { name: "city", type: "string" },
          { name: "pop", type: "number" },
        ],
      });
      const { rowIds } = await call("add_rows", {
        datasetId: dataset.id,
        rows: [
          { values: { city: "Oslo", pop: 700 } },
          { values: { city: "Bergen", pop: 290 } },
        ],
      });

      await call("update_rows", {
        datasetId: dataset.id,
        updates: [{ rowId: rowIds[0], values: { pop: 710, city: null } }],
      });
      expect(
        await call("delete_rows", {
          datasetId: dataset.id,
          rowIds: [rowIds[1], "no-such-row"],
        }),
      ).toEqual({ deleted: 1 });
      await call("rename_field", {
        datasetId: dataset.id,
        field: "pop",
        name: "population",
      });
      expect(
        (await call("list_dataset_rows", { datasetId: dataset.id })).map(
          (r: { values: unknown }) => r.values,
        ),
      ).toEqual([{ population: 710 }]);

      await call("delete_field", {
        datasetId: dataset.id,
        field: "population",
      });
      const added = await call("add_field", {
        datasetId: dataset.id,
        field: { name: "country", type: "string" },
      });
      expect(added.id).toBe("2");
      expect(
        (await call("get_dataset", { datasetId: dataset.id })).fields,
      ).toEqual([
        { id: "0", name: "city", type: "string" },
        { id: "2", name: "country", type: "string" },
      ]);

      await expect(
        call("add_rows", {
          datasetId: dataset.id,
          rows: [{ values: { nope: 1 } }],
        }),
      ).rejects.toThrow('No field "nope"');
      await expect(
        call("update_rows", {
          datasetId: dataset.id,
          updates: [{ rowId: rowIds[0], values: { city: 5 } }],
        }),
      ).rejects.toThrow("must be a string value");
    });

    it("takes back the keys list_dataset_rows gives, even for fields it has to disambiguate", async () => {
      const { call } = await setup();
      const dataset = await call("create_dataset", {
        name: "Ambiguous",
        fields: [
          { name: "city", type: "string" },
          { name: "city", type: "number" },
          { name: "_id", type: "string" },
        ],
      });
      await call("add_rows", {
        datasetId: dataset.id,
        rows: [{ values: { "0": "Oslo", "1": 1, "2": "mine" } }],
      });
      const [row] = await call("list_dataset_rows", { datasetId: dataset.id });
      expect(row.values).toEqual({
        city: "Oslo",
        "city#1": 1,
        "_id#2": "mine",
      });

      // Every key comes back as it went out.
      await call("update_rows", {
        datasetId: dataset.id,
        updates: [
          {
            rowId: row.id,
            values: { "city#1": 2, "_id#2": "still mine", city: "Bergen" },
          },
        ],
      });
      const [updated] = await call("list_dataset_rows", {
        datasetId: dataset.id,
      });
      expect(updated.values).toEqual({
        city: "Bergen",
        "city#1": 2,
        "_id#2": "still mine",
      });
    });

    it("renames, lists, and deletes datasets", async () => {
      const { call } = await setup();
      const dataset = await call("create_dataset", { name: "One" });
      await call("rename_dataset", { datasetId: dataset.id, name: "Uno" });
      expect(
        (await call("list_datasets")).map((d: { name: string }) => d.name),
      ).toEqual(["Uno"]);
      await call("delete_dataset", { datasetId: dataset.id });
      expect(await call("list_datasets")).toEqual([]);
      await expect(
        call("get_dataset", { datasetId: dataset.id }),
      ).rejects.toThrow("Dataset not found");
    });
  });

  describe("evals", () => {
    /** A dataset made from the greet prompt, plus an `expected` column, with two rows. */
    async function greetings(call: Awaited<ReturnType<typeof setup>>["call"]) {
      const dataset = await call("create_dataset", {
        name: "Greetings",
        fromPrompt: { promptId: "greet" },
        fields: [{ name: "expected", type: "string" }],
      });
      await call("add_rows", {
        datasetId: dataset.id,
        rows: [
          { values: { name: "Ada", excited: true, expected: "Ada!" } },
          { values: { name: "Grace", excited: false, expected: "Grace!" } },
        ],
      });
      return dataset;
    }

    const contains = {
      uri: "evalution/checks#outputContains",
      args: { text: { column: "expected" } },
    };

    /** Polls get_eval_run until the run is over. */
    async function finished(
      call: Awaited<ReturnType<typeof setup>>["call"],
      runId: string,
      args: Record<string, unknown> = {},
    ) {
      return vi.waitFor(
        async () => {
          const run = await call("get_eval_run", { runId, ...args });
          expect(run.running).toBe(false);
          expect(run.status).not.toBe("running");
          return run;
        },
        { timeout: 5000, interval: 20 },
      );
    }

    it("lists the checks an eval can use, with their parameters", async () => {
      const { call } = await setup();
      const checks = await call("list_checks");
      expect(
        checks.find(
          (c: { uri: string }) => c.uri === "evalution/checks#outputContains",
        ),
      ).toMatchObject({
        label: "Output contains",
        parameters: [
          { name: "text", type: "string", optional: false },
          { name: "caseSensitive", type: "boolean", optional: true },
        ],
      });
    });

    it("creates an eval, binding parameters to matching columns, and shows bindings by column name", async () => {
      const { call } = await setup();
      const dataset = await greetings(call);
      const created = await call("create_eval", {
        name: "Greets",
        promptId: "greet",
        datasetId: dataset.id,
        checks: [contains],
      });
      expect(created).toMatchObject({
        providerId: "evals",
        name: "Greets",
        prompt: { id: "greet", providerId: "files", promptId: GREET.id },
        dataset: { providerId: "local-datasets", id: dataset.id },
        inputs: {
          functionInputs: {
            name: { column: "name" },
            excited: { column: "excited" },
          },
          executeInputs: {},
        },
        checks: [
          {
            id: "outputContains",
            uri: contains.uri,
            args: { text: { column: "expected" } },
          },
        ],
        problems: [],
      });
      expect(await call("get_eval", { evalId: created.id })).toEqual(created);
      expect(await call("list_evals")).toEqual([
        expect.objectContaining({ id: created.id, name: "Greets" }),
      ]);
    });

    it("updates bindings by name, unbinds with null, and reports what's left to bind", async () => {
      const { call } = await setup();
      const dataset = await greetings(call);
      const { id } = await call("create_eval", {
        name: "Greets",
        promptId: "greet",
        datasetId: dataset.id,
        autoBind: false,
      });
      const unbound = await call("get_eval", { evalId: id });
      expect(unbound.inputs.functionInputs).toEqual({});
      expect(unbound.problems).toEqual([expect.stringContaining("name")]);

      const updated = await call("update_eval", {
        evalId: id,
        name: "Renamed",
        functionInputs: {
          name: { json: "Ada" },
          excited: { column: "excited" },
        },
        autoBind: false,
      });
      expect(updated).toMatchObject({
        name: "Renamed",
        inputs: {
          functionInputs: {
            name: { json: "Ada" },
            excited: { column: "excited" },
          },
        },
        problems: [],
      });

      const cleared = await call("update_eval", {
        evalId: id,
        functionInputs: { excited: null },
        autoBind: false,
      });
      expect(cleared.inputs.functionInputs).toEqual({ name: { json: "Ada" } });

      await expect(
        call("update_eval", {
          evalId: id,
          functionInputs: { name: { column: "nope" } },
        }),
      ).rejects.toThrow(/No field "nope"/);

      expect(await call("delete_eval", { evalId: id })).toEqual({
        deleted: id,
      });
      expect(await call("list_evals")).toEqual([]);
    });

    it("keeps a parameter unbound with null unbound, auto-binding only what the call changes", async () => {
      const { call } = await setup();
      const dataset = await greetings(call);
      const { id } = await call("create_eval", {
        name: "Greets",
        promptId: "greet",
        datasetId: dataset.id,
      });
      const cleared = await call("update_eval", {
        evalId: id,
        functionInputs: { excited: null },
      });
      expect(cleared.inputs.functionInputs).toEqual({
        name: { column: "name" },
      });
      // A later change leaves it unbound too.
      const renamed = await call("update_eval", { evalId: id, name: "Again" });
      expect(renamed.inputs.functionInputs).toEqual({
        name: { column: "name" },
      });
      // Pointing the eval at a dataset binds what's unbound, unless unbound in the same call.
      const rebound = await call("update_eval", {
        evalId: id,
        datasetId: dataset.id,
        functionInputs: { name: null },
      });
      expect(rebound.inputs.functionInputs).toEqual({
        excited: { column: "excited" },
      });
    });

    it("shows a column sharing its name with another by its query column, and takes it back", async () => {
      const { call } = await setup();
      const dataset = await greetings(call);
      await call("add_field", {
        datasetId: dataset.id,
        field: { name: "expected", type: "number" },
      });
      const created = await call("create_eval", {
        name: "Greets",
        promptId: "greet",
        datasetId: dataset.id,
        checks: [{ ...contains, args: { text: { column: "3" } } }],
      });
      expect(created.checks[0].args).toEqual({
        text: { column: "expected#3" },
      });
      const updated = await call("update_eval", {
        evalId: created.id,
        checks: created.checks,
      });
      expect(updated.checks[0].args).toEqual({
        text: { column: "expected#3" },
      });
    });

    it("refuses to start a run while the eval has problems", async () => {
      const { call } = await setup();
      const dataset = await greetings(call);
      const { id } = await call("create_eval", {
        name: "Greets",
        promptId: "greet",
        datasetId: dataset.id,
        autoBind: false,
      });
      await expect(call("start_eval_run", { evalId: id })).rejects.toThrow(
        /name/,
      );
    });

    it("starts a run without waiting, then reports its progress, results, and traces", async () => {
      const { call } = await setup();
      const dataset = await greetings(call);
      const { id } = await call("create_eval", {
        name: "Greets",
        promptId: "greet",
        datasetId: dataset.id,
        checks: [contains],
      });

      const started = await call("start_eval_run", { evalId: id });
      expect(started).toMatchObject({
        evalId: id,
        providerId: "evals",
        status: "running",
        total: 2,
        arms: [{ id: expect.any(String), label: expect.any(String) }],
      });

      const run = await finished(call, started.runId);
      expect(run).toMatchObject({
        id: started.runId,
        status: "done",
        done: 2,
        total: 2,
        checks: [{ id: "outputContains", uri: contains.uri }],
        arms: [
          {
            summary: {
              checks: [
                {
                  checkId: "outputContains",
                  passRate: 0.5,
                  counts: { pass: 1, fail: 1 },
                },
              ],
              rowErrors: 0,
            },
          },
        ],
        resultRows: 2,
      });
      expect(run.results).toEqual([
        expect.objectContaining({
          rowIndex: 0,
          status: "ok",
          inputs: { name: "Ada", excited: true, expected: "Ada!" },
          traceProviderId: "local",
          traceId: expect.any(String),
          checks: [{ checkId: "outputContains", outcome: "pass" }],
        }),
        expect.objectContaining({
          rowIndex: 1,
          inputs: { name: "Grace", excited: false, expected: "Grace!" },
          checks: [
            expect.objectContaining({
              checkId: "outputContains",
              outcome: "fail",
            }),
          ],
        }),
      ]);

      const failing = await call("get_eval_run", {
        runId: started.runId,
        failingOnly: true,
      });
      expect(failing.resultRows).toBe(1);
      expect(
        failing.results.map((r: { rowIndex: number }) => r.rowIndex),
      ).toEqual([1]);

      // Each result points at the trace it recorded.
      const [trace] = await call("get_traces", {
        traceIds: [failing.results[0].traceId],
        providerId: failing.results[0].traceProviderId,
      });
      expect(trace.spans[0].llm.output).toBe("Hello, Grace.");

      expect(await call("list_eval_runs", { evalId: id })).toEqual([
        expect.objectContaining({ id: started.runId, status: "done", done: 2 }),
      ]);
      await expect(
        call("cancel_eval_run", { runId: started.runId }),
      ).rejects.toThrow(/isn't running/);
      expect(await call("delete_eval_run", { runId: started.runId })).toEqual({
        deleted: started.runId,
      });
      expect(await call("list_eval_runs", { evalId: id })).toEqual([]);
    });
  });
});
