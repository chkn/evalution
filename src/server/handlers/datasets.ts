// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Runtime-neutral handlers for the `/api/datasets` routes — resolved
 * providers in, `{ status, body }` out, in the `annotations.ts` style. Every
 * write is validated here: a malformed cell is a 400 now, not a row that
 * fails later. See `specs/datasets.md` §F, §G.
 */

import {
  DatasetNotFoundError,
  type DatasetProvider,
  DatasetValidationError,
  type NewDatasetRow,
} from "../../dataset/dataset-provider.ts";
import type {
  Dataset,
  DatasetField,
  DatasetRowSource,
  DatasetRowsOverview,
  DatasetSummary,
} from "../../dataset/dataset-types.ts";
import { InvalidCellError, parseCell } from "../../shared/dataset-cells.ts";
import type {
  ExecutionInput,
  PromptID,
  PropDefinition,
} from "../../shared/types.ts";

/** The body of `GET /api/datasets/:providerId/:id`. */
export interface DatasetWithOverview extends DatasetRowsOverview {
  dataset: Dataset;
}

/** What a dataset handler returns; the route relays it. */
export interface DatasetHandlerResult {
  status: number;
  body: unknown;
}

/**
 * Maps a stored prompt link to one the client can open — `undefined` when it
 * no longer resolves, so the client gets an openable link or none at all.
 */
export type ResolvePromptLink = (prompt: PromptID) => PromptID | undefined;

/** A request body that doesn't fit, reported as a 400. */
class BadRequest extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Relays a provider's or validator's failure as the status it deserves. */
function failure(err: unknown): DatasetHandlerResult {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DatasetNotFoundError) {
    return { status: 404, body: { error: message } };
  }
  if (
    err instanceof DatasetValidationError ||
    err instanceof InvalidCellError ||
    err instanceof BadRequest
  ) {
    return { status: 400, body: { error: message } };
  }
  return { status: 500, body: { error: message } };
}

function withResolvedPrompt<T extends { prompt?: PromptID }>(
  item: T,
  resolvePrompt: ResolvePromptLink,
): T {
  if (!item.prompt) return item;
  const { prompt, ...rest } = item;
  const resolved = resolvePrompt(prompt);
  return (resolved ? { ...rest, prompt: resolved } : rest) as T;
}

function parsePromptLink(value: unknown): PromptID | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new BadRequest("prompt must be { id, providerId? }");
  }
  if (value.providerId !== undefined && typeof value.providerId !== "string") {
    throw new BadRequest("prompt.providerId must be a string");
  }
  // Only the reference is kept — never inputs, which a link has no use for.
  return {
    id: value.id,
    ...(value.providerId ? { providerId: value.providerId as string } : {}),
  };
}

/**
 * Checks a create body's fields: each a `{ def }` whose `def` has a name and
 * a type with `syntax`, unique by `(name, type.syntax)` — the one matching
 * rule datasets use (§B).
 */
function parseFields(value: unknown): Omit<DatasetField, "id">[] {
  if (!Array.isArray(value)) throw new BadRequest("fields must be an array");
  const seen = new Set<string>();
  return value.map((field, i) => {
    const def = isRecord(field) ? field.def : undefined;
    if (
      !isRecord(def) ||
      typeof def.name !== "string" ||
      !def.name ||
      !isRecord(def.type) ||
      typeof def.type.syntax !== "string"
    ) {
      throw new BadRequest(
        `fields[${i}].def must be a PropDefinition with a name and type`,
      );
    }
    const key = `${def.name}\u0000${def.type.syntax}`;
    if (seen.has(key)) {
      throw new BadRequest(
        `fields[${i}] duplicates "${def.name}: ${def.type.syntax}"`,
      );
    }
    seen.add(key);
    return { def: def as unknown as PropDefinition };
  });
}

function parseSource(
  value: unknown,
  path: string,
): DatasetRowSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (isRecord(value)) {
    if (
      value.kind === "playground" &&
      typeof value.promptId === "string" &&
      typeof value.providerId === "string"
    ) {
      return {
        kind: "playground",
        promptId: value.promptId,
        providerId: value.providerId,
      };
    }
    if (
      value.kind === "trace" &&
      typeof value.traceId === "string" &&
      typeof value.traceProviderId === "string"
    ) {
      return {
        kind: "trace",
        traceId: value.traceId,
        traceProviderId: value.traceProviderId,
      };
    }
  }
  throw new BadRequest(`${path} is not a valid row source`);
}

function parseRows(value: unknown): NewDatasetRow[] {
  if (!isRecord(value) || !Array.isArray(value.rows)) {
    throw new BadRequest("body must be { rows: [...] }");
  }
  return value.rows.map((row, i) => {
    if (!isRecord(row) || !isRecord(row.cells)) {
      throw new BadRequest(`rows[${i}].cells must be an object`);
    }
    const cells: Record<string, ExecutionInput> = {};
    for (const [fieldId, cell] of Object.entries(row.cells)) {
      if (cell === undefined || cell === null) continue;
      cells[fieldId] = parseCell(cell, `rows[${i}].cells.${fieldId}`);
    }
    const source = parseSource(row.source, `rows[${i}].source`);
    return { cells, ...(source && { source }) };
  });
}

function parseName(body: unknown): string {
  const name = isRecord(body) ? body.name : undefined;
  if (typeof name !== "string" || !name.trim()) {
    throw new BadRequest("name must be a non-empty string");
  }
  return name.trim();
}

/** `GET /api/datasets` */
export async function handleListDatasets(
  providers: Iterable<DatasetProvider>,
  resolvePrompt: ResolvePromptLink,
): Promise<DatasetHandlerResult> {
  try {
    const lists = await Promise.all(
      Array.from(providers, p => p.listDatasets()),
    );
    const summaries: DatasetSummary[] = lists
      .flat()
      .map(s => withResolvedPrompt(s, resolvePrompt))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { status: 200, body: summaries };
  } catch (err) {
    return failure(err);
  }
}

/** `POST /api/datasets/:providerId` */
export async function handleCreateDataset(
  provider: DatasetProvider,
  body: unknown,
  resolvePrompt: ResolvePromptLink,
): Promise<DatasetHandlerResult> {
  try {
    const name = parseName(body);
    const fields = parseFields(isRecord(body) ? body.fields : undefined);
    const prompt = parsePromptLink(isRecord(body) ? body.prompt : undefined);
    const dataset = await provider.createDataset({
      name,
      fields,
      ...(prompt && { prompt }),
    });
    return {
      status: 201,
      body: withResolvedPrompt<Dataset>(dataset, resolvePrompt),
    };
  } catch (err) {
    return failure(err);
  }
}

/**
 * `GET /api/datasets/:providerId/:id` — the dataset and a
 * {@link DatasetRowsOverview} of its rows, but not the rows themselves: they
 * grow without bound, so a client pages them in from
 * {@link handleListRows}.
 */
export async function handleGetDataset(
  provider: DatasetProvider,
  datasetId: string,
  resolvePrompt: ResolvePromptLink,
): Promise<DatasetHandlerResult> {
  try {
    const dataset = await provider.getDataset(datasetId);
    if (!dataset) throw new DatasetNotFoundError(datasetId);
    const overview = await provider.describeRows(datasetId);
    return {
      status: 200,
      body: {
        dataset: withResolvedPrompt(dataset, resolvePrompt),
        ...overview,
      } satisfies DatasetWithOverview,
    };
  } catch (err) {
    return failure(err);
  }
}

/** The most rows one {@link handleListRows} request returns. */
export const MAX_ROWS_PAGE = 1000;

/** Parses an optional non-negative integer query parameter. */
function parseCount(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequest(`${name} must be a non-negative integer`);
  }
  return n;
}

/**
 * `GET /api/datasets/:providerId/:id/rows?offset=&limit=` — one page of rows,
 * oldest first. `limit` defaults to, and is capped at, {@link MAX_ROWS_PAGE}.
 */
export async function handleListRows(
  provider: DatasetProvider,
  datasetId: string,
  query: { offset?: string; limit?: string },
): Promise<DatasetHandlerResult> {
  try {
    const offset = parseCount(query.offset, "offset") ?? 0;
    const limit = Math.min(
      parseCount(query.limit, "limit") ?? MAX_ROWS_PAGE,
      MAX_ROWS_PAGE,
    );
    if (!(await provider.getDataset(datasetId))) {
      throw new DatasetNotFoundError(datasetId);
    }
    const rows = await provider.listRows(datasetId, { offset, limit });
    return { status: 200, body: rows };
  } catch (err) {
    return failure(err);
  }
}

/** `PATCH /api/datasets/:providerId/:id` — rename. */
export async function handleRenameDataset(
  provider: DatasetProvider,
  datasetId: string,
  body: unknown,
  resolvePrompt: ResolvePromptLink,
): Promise<DatasetHandlerResult> {
  try {
    const dataset = await provider.renameDataset(datasetId, parseName(body));
    return { status: 200, body: withResolvedPrompt(dataset, resolvePrompt) };
  } catch (err) {
    return failure(err);
  }
}

/** `DELETE /api/datasets/:providerId/:id` */
export async function handleDeleteDataset(
  provider: DatasetProvider,
  datasetId: string,
): Promise<DatasetHandlerResult> {
  try {
    await provider.deleteDataset(datasetId);
    return { status: 204, body: undefined };
  } catch (err) {
    return failure(err);
  }
}

/** `POST /api/datasets/:providerId/:id/rows` — body `{ rows: [{ cells, source? }] }`. */
export async function handleAddRows(
  provider: DatasetProvider,
  datasetId: string,
  body: unknown,
): Promise<DatasetHandlerResult> {
  try {
    const rows = parseRows(body);
    const added = await provider.addRows(datasetId, rows);
    return { status: 201, body: added };
  } catch (err) {
    return failure(err);
  }
}

/** `DELETE /api/datasets/:providerId/:id/rows/:rowId` */
export async function handleDeleteRow(
  provider: DatasetProvider,
  datasetId: string,
  rowId: string,
): Promise<DatasetHandlerResult> {
  try {
    await provider.deleteRow(datasetId, rowId);
    return { status: 204, body: undefined };
  } catch (err) {
    return failure(err);
  }
}
