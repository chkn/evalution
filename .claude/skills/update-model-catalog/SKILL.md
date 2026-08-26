---
name: update-model-catalog
description: Refresh the hardcoded LLM model lists (OpenAI, Anthropic, Google) in the SDK adapters' getModelCatalog(). Use when asked to update, add, or check model IDs — "add the latest models", "is this model list current", "add <model> to the picker".
---

# Updating the model catalogs

The model pickers are hardcoded lists in `getModelCatalog()`. There are **two** catalogs, and **both are in scope on every refresh** — a Google model added to one belongs in the other too (subject to the per-file notes below). Never update just one.

| File | Scope | Shape |
|---|---|---|
| `src/sdk/vercel-ai-sdk/index.ts` | OpenAI + Anthropic + Google | `model(group, label, provider, modelId)` helper |
| `src/sdk/gemini-interactions-sdk.ts` | Google only, via the Interactions API | `catalogEntry(key, label, id)` helper |

## Rule: only official provider docs

**Never answer from memory, and never use third-party aggregators** (benchlm.ai, releasebot, blog posts, "latest models" roundups). They lag, they omit active models, and they mislabel deprecations. Aggregators are acceptable for *narrative* context only — tier ordering, which variant is the flagship — never for the ID strings or the active/deprecated status.

| Provider | Official list |
|---|---|
| OpenAI | https://developers.openai.com/api/docs/models/all |
| Anthropic | https://platform.claude.com/docs/en/about-claude/models/overview |
| Google | https://ai.google.dev/gemini-api/docs/models |

WebFetch each one. Ask for exact API ID strings plus display names, and ask explicitly which entries are marked preview / legacy / deprecated.

### Per-provider gotchas

**OpenAI** — the page is sectioned. **Frontier models** holds the current flagship family; **More models** holds the still-active older generations *and* the deprecated ones, mixed together with status badges. A model missing from Frontier is not necessarily retired — check its badge in More models before removing it. Skip the non-chat sections entirely: Image, Realtime & audio, Daybreak, Open-weight, Embeddings, ChatGPT.

**Anthropic** — the comparison table at the top is the *current* lineup only. Legacy-but-still-available models are named in a one-line list below the table; keep those in the catalog until they actually retire. Take the **"Claude API alias"** row, not the "Claude API ID" row — the alias is the dateless form (`claude-haiku-4-5`, not `claude-haiku-4-5-20251001`) and is what `@ai-sdk/anthropic` expects. Ignore the Bedrock / Vertex / Foundry ID rows. Exclude invitation-only models (e.g. `claude-mythos-5`, Project Glasswing) — users can't call them. Note that `docs.claude.com` 302s to `platform.claude.com`; WebFetch reports the redirect instead of following it, so call it again with the new URL.

**Google** — the page separates **Stable** from **Preview**. Preview IDs carry the `-preview` suffix and must be copied verbatim; a preview model usually drops the suffix when it goes stable, so re-check existing `*-preview` entries on every pass rather than assuming they're still current. Skip image (Nano Banana), TTS, Live, embedding, and computer-use entries — text generation only. Deep Research and Antigravity are the exception: they're agents, excluded from `vercel-ai-sdk/index.ts` but in scope for `gemini-interactions-sdk.ts` under its `agent` value type.

## Editing

Both catalogs are pure data — **prune as readily as you add.** Removing an entry does not break prompts: a prompt stores its own model ID in the source file, and the picker renders an unlisted value as a custom entry. A deprecated or shut-down model left in the list is worse than a missing one, because it's an active footgun in the picker. Every refresh should remove what the provider now marks deprecated, retired, or superseded, not just append what's new.

Watch for the silent supersede: an ID that simply *vanishes* from the official page is as stale as one wearing a deprecation badge. Preview IDs are the usual case — `gemini-3.1-flash-lite-preview` became `gemini-3.1-flash-lite`, and `deep-research-pro-preview-12-2025` became `deep-research-preview-04-2026`. Diff the existing list against the page in both directions.

**`vercel-ai-sdk/index.ts`** — add rows to `models:` via the `model()` helper. It derives both the provider-function value (`openai("gpt-5.6-sol")`) and the gateway string (`"openai/gpt-5.6-sol"`) from one ID, so one entry per model. Groups stay in order OpenAI → Anthropic → Google, separated by blank lines. A new group also needs a `customValueTemplates` entry under `groups`.

**`gemini-interactions-sdk.ts`** — add rows via `catalogEntry(key, label, id)`, where `key` is `MODEL_KEY` or `AGENT_KEY`. That key is the point of the helper: this API is driven by either a `model:` or an `agent:` property, and the entry carries which one it writes so `denormalizeUpdates` can read it back. Agents (Deep Research and friends) are real products here, so check the docs' agent list too, not just the models. The supported set is **not** the whole Gemini lineup — verify against https://ai.google.dev/gemini-api/docs/interactions, which enumerates exactly what the API accepts. Keep models before agents in the array; a test asserts `models[0].values.model` is defined.

Shared conventions:

- Within a group, **newest first**; within one family, most capable first (e.g. Sol → Terra → Luna, Pro → base → mini → nano).
- `label` is the provider's own display name ("GPT-5.6 Sol", "Claude Opus 5", "Gemini 3.7 Flash"). Keep "Preview" in the label when the ID says preview.

## Verify

```bash
npm run typecheck
npx vitest run src/sdk/vercel-ai-sdk/index.test.ts src/sdk/gemini-interactions-sdk.test.ts src/server/service-worker.test.ts
```

No new test is needed for a pure data-table refresh — the existing catalog tests cover the shape. A change to the `model()` helper or the catalog *structure* does need one.

**If a catalog test fails after you prune an entry:** `gemini-interactions-sdk.test.ts` pins the generated shape of one model entry and one agent entry by looking them up by ID, so removing either one breaks it. That is a stale fixture, not a regression — repoint the test at another entry of the same kind (a model entry for the model case, an agent entry for the agent case) and keep the assertions as they are. Don't delete the test, and don't keep a dead model in the catalog just to satisfy it.

Finish by reporting three lists: IDs added, IDs removed (with the reason — deprecated, retired, or superseded by X), and IDs verified still active. Include the date you fetched the docs.
