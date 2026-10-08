// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * What the MCP server's tools share: results, errors, and finding the
 * provider, prompt, trace, or field a tool call names.
 */

import * as z from "zod";
import { datasetQueryColumns } from "../dataset/dataset-query.ts";
import type { DatasetField, DatasetRow } from "../dataset/dataset-types.ts";
import type { PromptProvider } from "../prompt/prompt-provider.ts";
import type { ApiContext } from "../server/api-context.ts";
import type { HandlerResult } from "../server/handlers/result.ts";
import { propValueToJson } from "../shared/json-prop-value.ts";
import type { ExecutionInput, PromptRef } from "../shared/types.ts";
import type { TraceProvider } from "../trace/trace-provider.ts";

/** What a tool callback returns. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A tool result carrying `value` as JSON text, or a string as-is. */
export function ok(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

/** A tool error result. */
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Thrown inside a tool to answer it with an error. */
export class ToolError extends Error {}

/** A failed handler result's message, with the conflicts behind it when it has them. */
export function failureMessage(result: HandlerResult): string {
  const body = result.body as { error?: string; conflicts?: unknown };
  const error = body?.error ?? `Failed with status ${result.status}`;
  return body?.conflicts
    ? `${error}\n${JSON.stringify(body.conflicts)}`
    : error;
}

/** The body of a successful handler result; throws its error otherwise. */
export function unwrap<T>(result: HandlerResult): T {
  if (result.status >= 400) throw new ToolError(failureMessage(result));
  return result.body as T;
}

/**
 * A handler's `{ status, body }` as a tool result: its body on success
 * (`fallback` for a bodyless 204), its error on failure.
 */
export function relay(result: HandlerResult, fallback: unknown = { ok: true }) {
  if (result.status >= 400) return fail(failureMessage(result));
  return ok(result.body === undefined ? fallback : result.body);
}

/** Runs a tool body, answering a thrown {@link ToolError} (or anything else) as an error result. */
export async function guard(
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The provider `id` names, or — when `id` is omitted — the only one there is.
 * Several and none named is an error listing them, since guessing would act
 * on the wrong store.
 */
export function pickProvider<P>(
  providers: Map<string, P>,
  id: string | undefined,
  kind: string,
): P {
  if (id !== undefined) {
    const provider = providers.get(id);
    if (!provider) {
      throw new ToolError(
        `No ${kind} provider "${id}". Available: ${[...providers.keys()].join(", ") || "none"}`,
      );
    }
    return provider;
  }
  const [only, ...rest] = providers.values();
  if (!only) throw new ToolError(`No ${kind} providers are configured.`);
  if (rest.length > 0) {
    throw new ToolError(
      `Several ${kind} providers are configured; pass providerId (one of ${[...providers.keys()].join(", ")}).`,
    );
  }
  return only;
}

/**
 * The prompt a tool call names: by provider-scoped id or by `globalId`,
 * in the named provider or any.
 */
export async function findPrompt(
  context: ApiContext,
  promptId: string,
  providerId: string | undefined,
): Promise<{ provider: PromptProvider; promptId: string }> {
  const resolved = context.promptRegistry.resolve(promptId, providerId);
  if (resolved) {
    const provider = context.promptProviders.get(resolved.providerId);
    if (provider) return { provider, promptId: resolved.promptId };
  }
  if (providerId !== undefined) {
    return {
      provider: pickProvider(context.promptProviders, providerId, "prompt"),
      promptId,
    };
  }
  for (const provider of context.promptProviders.values()) {
    if (await provider.getPrompt({ promptId })) return { provider, promptId };
  }
  throw new ToolError(
    `Prompt not found: ${promptId}. Call list_prompts for the available ids.`,
  );
}

/** The ref a tool call names: head, unless it gives a version or variation. */
export function refOf(
  promptId: string,
  { version, variation }: { version?: string; variation?: string },
): PromptRef {
  if (variation) return { promptId, variation };
  if (version) return { promptId, version };
  return { promptId };
}

/**
 * The trace provider holding `traceId`: the one named, or — when none is —
 * the first that has it.
 */
export async function findTrace(
  context: ApiContext,
  traceId: string,
  providerId: string | undefined,
): Promise<TraceProvider> {
  if (providerId !== undefined || context.traceProviders.size === 1) {
    return pickProvider(context.traceProviders, providerId, "trace");
  }
  for (const provider of context.traceProviders.values()) {
    if (await provider.getTrace(traceId)) return provider;
  }
  throw new ToolError(`Trace not found: ${traceId}`);
}

/**
 * The field `ref` names — its id, its column name in `rows` (which is also
 * how `list_dataset_rows` keys it, e.g. `city#3` for one of two `city`
 * fields), or else its name when exactly one field has that name.
 */
export function findField(
  fields: readonly DatasetField[],
  ref: string,
): DatasetField {
  const byId = fields.find(f => f.id === ref);
  if (byId) return byId;
  const column = datasetQueryColumns(fields).find(
    c => c.fieldId !== undefined && c.column === ref,
  );
  const byColumn = column && fields.find(f => f.id === column.fieldId);
  if (byColumn) return byColumn;
  const named = fields.filter(f => f.def.name === ref);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new ToolError(
      `Several fields are named "${ref}"; use one of their ids: ${named.map(f => `${f.id} (${f.def.type.syntax})`).join(", ")}`,
    );
  }
  throw new ToolError(
    `No field "${ref}". Fields: ${fields.map(f => `${f.def.name} (id ${f.id})`).join(", ") || "none"}`,
  );
}

/** A field as a tool shows it: id, name, and type, without the definition's catalogs and spans. */
export function describeField(field: DatasetField) {
  return {
    id: field.id,
    name: field.def.name,
    type: field.def.type.syntax,
    ...(field.def.description && { description: field.def.description }),
  };
}

/**
 * Each field's column name in the `rows` view, by field id: its name, or —
 * for a field sharing its name with an earlier one — its name and id
 * (`city#3`). The name tools show a field by, and {@link findField} takes.
 */
export function columnNames(
  fields: readonly DatasetField[],
): Map<string, string> {
  return new Map(
    datasetQueryColumns(fields)
      .filter(c => c.fieldId !== undefined)
      .map(c => [c.fieldId as string, c.column]),
  );
}

/**
 * Cells keyed by field name (as the `rows` view names its columns), as plain
 * JSON where a cell is a typed-in data value, else as the stored
 * {@link ExecutionInput}. A cell whose field is gone keeps its field id.
 */
export function describeCells(
  cells: Record<string, ExecutionInput>,
  fields: readonly DatasetField[],
): Record<string, unknown> {
  const columns = columnNames(fields);
  const values: Record<string, unknown> = {};
  for (const [fieldId, cell] of Object.entries(cells)) {
    const plain =
      cell.kind === "value" ? propValueToJson(cell.value) : undefined;
    values[columns.get(fieldId) ?? fieldId] =
      plain === undefined ? cell : plain;
  }
  return values;
}

/** A row as a tool shows it: see {@link describeCells}. */
export function describeRow(row: DatasetRow, fields: readonly DatasetField[]) {
  return {
    id: row.id,
    values: describeCells(row.cells, fields),
    ...(row.source && { source: row.source }),
    createdAt: row.createdAt,
  };
}

/** A tool parameter naming one of several providers of `kind`. */
export const providerIdParam = (kind: string) =>
  z
    .string()
    .optional()
    .describe(
      `The ${kind} provider's id. Optional when only one is configured.`,
    );

/** An unresolved input, as a tool parameter. */
export const executionInput = z
  .record(z.string(), z.unknown())
  .describe(
    'An unresolved input: {kind: "value", value: PropValue}, {kind: "object", properties: {...}}, or {kind: "instance", name, output?} naming one of the run\'s resource instances (or an output of it).',
  );

/** One named resource instance, as a tool parameter. */
export const resourceInstance = z.object({
  uri: z
    .string()
    .describe("The resource's uri (`<module>#<export>`), never an output's."),
  args: z
    .record(z.string(), executionInput)
    .optional()
    .describe("The resource's argument name → unresolved input."),
});

/** A run's named resource instances, as a tool parameter. */
export const runResources = z
  .record(z.string(), resourceInstance)
  .describe(
    "Named resource instances (letters, digits, '_' and '-'), each created once per run whether or not anything names it — so one can seed data purely as a side effect. Inputs (and other instances' args) name them with {kind: \"instance\", name, output?}.",
  );
