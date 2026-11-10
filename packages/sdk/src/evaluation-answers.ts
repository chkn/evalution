// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Alexander Corrado

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The per-question confidence a provider reported beside an evaluation's
 * answers, keyed by question id.
 *
 * The AI SDK's answers carry no confidence of their own: a provider that
 * computes one (TypeSafe does, for choice and score answers) reports it as
 * `providerMetadata.<provider>.confidence[questionId]`. Read from whichever
 * provider namespace has it, so this isn't tied to one provider.
 */
export function evaluationConfidence(
  providerMetadata: unknown,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(providerMetadata)) return out;
  for (const namespace of Object.values(providerMetadata)) {
    if (!isRecord(namespace) || !isRecord(namespace.confidence)) continue;
    for (const [id, value] of Object.entries(namespace.confidence)) {
      if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
    }
  }
  return out;
}

/**
 * An evaluation's answers as recorded on its span: each answer as the SDK
 * returned it, plus its `confidence` where the provider reported one (see
 * {@link evaluationConfidence}). Recorded together so a trace — from the
 * playground or sent over OTLP — can show confidence without knowing which
 * provider answered.
 */
export function answersWithConfidence(
  answers: unknown,
  providerMetadata: unknown,
): unknown {
  if (!isRecord(answers)) return answers;
  const confidence = evaluationConfidence(providerMetadata);
  if (Object.keys(confidence).length === 0) return answers;
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => [
      id,
      isRecord(answer) && id in confidence && !("confidence" in answer)
        ? { ...answer, confidence: confidence[id] }
        : answer,
    ]),
  );
}
