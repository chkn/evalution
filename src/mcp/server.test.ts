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
  const prompts = fakePromptProvider(traces);
  const promptProviders = new Map([[prompts.id, prompts]]);
  const promptRegistry = new PromptRegistry();
  await promptRegistry.rebuild(promptProviders);

  const context = createApiContext({
    promptProviders,
    traceProviders: new Map([[traces.id, traces]]),
    datasetProviders: new Map([[datasets.id, datasets]]),
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
      "create_annotation",
      "create_dataset",
      "delete_annotation",
      "delete_dataset",
      "delete_field",
      "delete_rows",
      "execute_prompt",
      "get_dataset",
      "get_prompt",
      "get_trace_schema",
      "get_traces",
      "list_annotations",
      "list_dataset_rows",
      "list_datasets",
      "list_prompts",
      "list_traces",
      "query_dataset_rows",
      "query_traces",
      "rename_dataset",
      "rename_field",
      "update_annotation",
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
      await call("delete_rows", { datasetId: dataset.id, rowIds: [rowIds[1]] });
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
});
