// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isStandardSchema } from "../../prompt/playground/resource.ts";

/**
 * What's wrong with a call's `toolsContext`, checked against each tool's
 * `contextSchema` before the call starts: one line per issue, by its path
 * (`toolsContext.update_task.runId: …`). Empty when every context matches.
 *
 * The SDK checks a tool's context only once the model calls that tool, and
 * reports a mismatch by `JSON.stringify`-ing the context, which throws on
 * the database client a context usually holds (a circular structure), losing
 * the schema's own message. This checks every tool up front, the way the
 * types already require, so a stale context fails before any tokens are
 * spent and says which field is wrong.
 *
 * A schema that isn't a Standard Schema (the SDK's own `jsonSchema()`) is
 * left for the SDK to check.
 */
export async function toolsContextProblems(
  tools: unknown,
  toolsContext: unknown,
): Promise<string[]> {
  if (typeof tools !== "object" || tools === null) return [];
  const contexts = (toolsContext ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const schema = (tool as { contextSchema?: unknown } | undefined)
      ?.contextSchema;
    if (!isStandardSchema(schema)) continue;
    const result = await schema["~standard"].validate(contexts[name]);
    for (const issue of result.issues ?? []) {
      const path = ["toolsContext", name, ...(issue.path ?? []).map(keyOf)];
      problems.push(`${path.join(".")}: ${issue.message}`);
    }
  }
  return problems;
}

function keyOf(segment: PropertyKey | StandardSchemaV1.PathSegment): string {
  return String(typeof segment === "object" ? segment.key : segment);
}
