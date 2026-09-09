// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Shared "attribute bag → evalution `Span` fields" rules for the two
 * provenances that carry OTel-shaped attributes: {@link OTelTraceIngestor}
 * and the OTLP ingestor. The third provenance, native Vercel AI SDK v7
 * telemetry, builds `Span`s directly and bypasses this module entirely — see
 * `specs/trace-workshopping.md` "Key findings that shape the approach". Not
 * dual-licensed: unlike `trace-types.ts`, nothing outside `src/trace/` needs
 * these rules, since an MIT-bundled SDK adapter has typed access to its own
 * events rather than an OTel attribute bag.
 */

import type { SpanStatus } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { otelOperationToSpanKind } from "../shared/helpers.ts";
import { SPAN_KIND_ATTRIBUTE } from "./prompt-tracer.ts";
import type {
  LLMSpanDetails,
  PromptID,
  Span,
  SpanContentPart,
  SpanKind,
  SpanMessage,
  ToolSpanDetails,
} from "./trace-types.ts";

const KNOWN_KINDS: readonly SpanKind[] = [
  "LLM",
  "TOOL",
  "AGENT",
  "EMBEDDING",
  "DEFAULT",
];

/**
 * Reads a span's {@link SpanKind} from its attributes: the explicit
 * `evalution.span.type` attribute if present, otherwise a mapping from the
 * OTel GenAI semconv `gen_ai.operation.name`. Falls back to `'DEFAULT'`.
 */
export function readKind(attributes: Record<string, unknown>): SpanKind {
  const raw =
    (attributes[SPAN_KIND_ATTRIBUTE] as SpanKind | undefined) ??
    otelOperationToSpanKind(attributes["gen_ai.operation.name"]);
  return typeof raw === "string" && KNOWN_KINDS.includes(raw) ? raw : "DEFAULT";
}

/** Maps an OTel `SpanStatus` to evalution's `ok | error | undefined`. */
export function mapStatus(status: SpanStatus): "ok" | "error" | undefined {
  if (status.code === SpanStatusCode.ERROR) return "error";
  if (status.code === SpanStatusCode.OK) return "ok";
  return undefined;
}

const PARAM_ATTRIBUTES = [
  "gen_ai.request.temperature",
  "gen_ai.request.max_tokens",
  "gen_ai.request.top_k",
  "gen_ai.request.top_p",
  "gen_ai.request.frequency_penalty",
  "gen_ai.request.presence_penalty",
  "gen_ai.request.seed",
  "gen_ai.request.stop_sequences",
  "gen_ai.request.choice.count",
] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Converts a raw message `content` value (a string, or an array of
 * OTel/Vercel-style content parts) into a {@link SpanMessage.content}. Image
 * (and image-bearing `file`) parts are kept rather than dropped — see §A.5 in
 * `specs/trace-workshopping.md`.
 */
function toMessageContent(
  content: unknown,
): string | SpanContentPart[] | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: SpanContentPart[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const part = c as Record<string, unknown>;
    if (part.type === "text") {
      const text = str(part.text);
      if (text) parts.push({ type: "text", text });
    } else if (part.type === "image") {
      const image = str(part.image) ?? str(part.url);
      if (image) {
        parts.push({
          type: "image",
          image,
          ...(str(part.mediaType) && { mediaType: str(part.mediaType) }),
        });
      }
    } else if (part.type === "file") {
      const mediaType = str(part.mediaType);
      const data = str(part.data) ?? str(part.url);
      if (mediaType?.startsWith("image/") && data) {
        parts.push({ type: "image", image: data, mediaType });
      }
    }
  }
  if (parts.length === 0) return undefined;
  // Collapse an all-text part list back to a plain string — the common case,
  // and keeps existing string-content consumers working unchanged.
  if (parts.every(p => p.type === "text")) {
    return parts.map(p => (p as { type: "text"; text: string }).text).join("");
  }
  return parts;
}

/**
 * Parses the OTel GenAI / Vercel AI SDK `*.messages` attribute (a JSON string
 * holding an array of `{role, content}` objects) into {@link SpanMessage}s. A
 * message whose content parses to nothing renderable (e.g. only unsupported
 * part types) is dropped; a malformed value returns `undefined` rather than
 * throwing.
 */
export function parseMessages(v: unknown): SpanMessage[] | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap((msg: unknown) => {
      if (!msg || typeof msg !== "object") return [];
      const m = msg as Record<string, unknown>;
      const role = str(m.role) ?? "unknown";
      const content = toMessageContent(m.content);
      return content !== undefined ? [{ role, content }] : [];
    });
  } catch {
    return undefined;
  }
}

/**
 * Parses the OTel GenAI `gen_ai.output.messages` attribute (a JSON string
 * holding an array of `{content}` objects) into a flattened text summary.
 * Image content parts have no textual representation and are omitted here;
 * they are only ever surfaced via {@link parseMessages} on the input side.
 */
export function parseOutput(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .flatMap((msg: unknown) => {
        if (!msg || typeof msg !== "object") return [];
        const m = msg as Record<string, unknown>;
        const content = m.content;
        if (typeof content === "string") return [content];
        if (Array.isArray(content)) {
          return content
            .filter(
              (c): c is Record<string, unknown> => !!c && typeof c === "object",
            )
            .filter(c => c.type === "text")
            .map(c => str(c.text) ?? "");
        }
        return [];
      })
      .join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Reads {@link LLMSpanDetails} out of an OTel-shaped attribute bag, following
 * both the OTel GenAI semantic conventions and the Vercel AI SDK's own
 * attribute names. Returns `undefined` when nothing LLM-related is present,
 * so callers can decide whether to attach `llm` to a `Span` at all.
 */
export function readLLM(
  attributes: Record<string, unknown>,
): LLMSpanDetails | undefined {
  const provider =
    str(attributes["gen_ai.provider.name"]) ?? str(attributes["gen_ai.system"]);
  const model =
    str(attributes["gen_ai.response.model"]) ??
    str(attributes["gen_ai.request.model"]);
  // Token usage: OTel GenAI semconv keys, falling back to the Vercel AI SDK's
  // and the two `gen_ai.usage.{prompt,completion}_tokens` fallbacks Workshop
  // added for SDKs that predate the semconv's `input`/`output` rename.
  const promptTokens =
    num(attributes["gen_ai.usage.input_tokens"]) ??
    num(attributes["gen_ai.usage.prompt_tokens"]) ??
    num(attributes["ai.usage.promptTokens"]);
  const completionTokens =
    num(attributes["gen_ai.usage.output_tokens"]) ??
    num(attributes["gen_ai.usage.completion_tokens"]) ??
    num(attributes["ai.usage.completionTokens"]);
  // Input/output: the OTel GenAI semconv uses `gen_ai.{input,output}.messages`,
  // but the Vercel AI SDK instead emits `ai.prompt.messages` (a JSON message
  // array) and `ai.response.text` (a plain string). Support both.
  const messages = parseMessages(
    attributes["gen_ai.input.messages"] ?? attributes["ai.prompt.messages"],
  );
  const output =
    parseOutput(attributes["gen_ai.output.messages"]) ??
    str(attributes["ai.response.text"]);

  const paramEntries = PARAM_ATTRIBUTES.map(
    key => [key.replace("gen_ai.request.", ""), attributes[key]] as const,
  ).filter(([, v]) => v !== undefined);
  const modelParameters =
    paramEntries.length > 0 ? Object.fromEntries(paramEntries) : undefined;

  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined;

  if (
    !provider &&
    !model &&
    !promptTokens &&
    !completionTokens &&
    !messages &&
    !output &&
    !modelParameters
  ) {
    return undefined;
  }

  return {
    ...(provider && { provider }),
    ...(model && { model }),
    ...(messages && { messages }),
    ...(output && { output }),
    ...(promptTokens !== undefined && { promptTokens }),
    ...(completionTokens !== undefined && { completionTokens }),
    ...(totalTokens !== undefined && { totalTokens }),
    ...(modelParameters && { modelParameters }),
  };
}

/**
 * Read back the inputs a run was launched with.
 *
 * OTel attribute values are primitives, so the inputs travel as a JSON string
 * (see `getPromptSpanAttributes`) and are parsed here. Without this the OTel
 * path could record inputs but never replay them — it was write-only.
 *
 * A malformed value is dropped rather than thrown on: a span carrying an
 * unreadable attribute is still a perfectly good span.
 */
export function readInputs(
  attributes: Record<string, unknown>,
): Pick<PromptID, "functionInputs" | "executeInputs" | "parameterDefinitions"> {
  const raw = str(attributes["evalution.prompt.inputs"]);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return {
      ...(Array.isArray(parsed.functionInputs) && {
        functionInputs: parsed.functionInputs,
      }),
      ...(parsed.executeInputs && typeof parsed.executeInputs === "object"
        ? { executeInputs: parsed.executeInputs }
        : {}),
      ...(Array.isArray(parsed.parameterDefinitions) && {
        parameterDefinitions: parsed.parameterDefinitions,
      }),
    };
  } catch {
    return {};
  }
}

function parseJsonOrRaw(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Reads {@link ToolSpanDetails} out of an attribute bag, following the tool
 * -call attribute names of the SDKs/instrumentation libraries a `TOOL` span
 * is likely to come from: the Vercel AI SDK (`ai.toolCall.*`), Traceloop
 * (`traceloop.entity.*`, gated on `traceloop.span.kind === 'tool'`), and the
 * draft OTel GenAI tool-call semconv (`gen_ai.tool.*`). `input`/`output` are
 * JSON-parsed when they arrive as a JSON string, else kept as-is. Returns
 * `undefined` when no tool name is present.
 */
export function readTool(
  attributes: Record<string, unknown>,
): ToolSpanDetails | undefined {
  const name =
    str(attributes["gen_ai.tool.name"]) ??
    str(attributes["ai.toolCall.name"]) ??
    str(attributes["tool.name"]) ??
    (attributes["traceloop.span.kind"] === "tool"
      ? str(attributes["traceloop.entity.name"])
      : undefined);
  if (!name) return undefined;

  const input = parseJsonOrRaw(
    attributes["gen_ai.tool.call.arguments"] ??
      attributes["ai.toolCall.args"] ??
      attributes["tool.input"] ??
      attributes["traceloop.entity.input"],
  );
  const outputRaw =
    attributes["gen_ai.tool.call.result"] ??
    attributes["ai.toolCall.result"] ??
    attributes["tool.output"] ??
    attributes["traceloop.entity.output"];

  return {
    toolName: name,
    input,
    ...(outputRaw !== undefined && { output: parseJsonOrRaw(outputRaw) }),
  };
}

/**
 * Reads {@link LLMSpanDetails} ({@link readLLM}), {@link ToolSpanDetails}
 * ({@link readTool}), and the prompt reference (`evalution.prompt.id` /
 * `evalution.prompt.provider.id` / the inputs {@link readInputs} parses) out
 * of an attribute bag, ready to spread onto a `Span`.
 */
export function llmAndPrompt(
  attributes: Record<string, unknown>,
): Partial<Span> {
  const llm = readLLM(attributes);
  const tool = readTool(attributes);
  // Store the prompt reference exactly as emitted: `id` is global unless a
  // provider id scopes it. Resolution to a concrete prompt happens later, when
  // a trace is served, so the stored (possibly global) id stays stable.
  const id = str(attributes["evalution.prompt.id"]);
  const providerId = str(attributes["evalution.prompt.provider.id"]);
  const prompt: PromptID | undefined = id
    ? { id, ...(providerId && { providerId }), ...readInputs(attributes) }
    : undefined;
  return {
    ...(llm && { llm }),
    ...(tool && { tool }),
    ...(prompt && { prompt }),
  };
}
