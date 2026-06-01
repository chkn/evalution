import type { PromptProvider } from './prompt-provider.ts';
import type { PromptID } from '../shared/types.ts';

/** A provider-scoped prompt reference that a {@link PromptID} resolves to. */
export interface ResolvedPrompt {
  /** The provider that owns the prompt. */
  providerId: string;
  /** The provider-scoped prompt ID (e.g. `relativeFilePath#functionName`). */
  promptId: string;
}

/**
 * Maps globally-usable prompt IDs to the provider-scoped prompt they refer to,
 * so runtime trace spans (which carry only a {@link PromptID}) can be linked
 * back to a concrete prompt.
 *
 * The map is built by scanning every provider's prompts: each prompt registers
 * both its provider-scoped `id` and its author-supplied `globalId` (when set) as
 * keys. A key seen from more than one prompt is **ambiguous** — it is nulled out
 * so it can never resolve to the wrong prompt.
 */
export class PromptRegistry {
  /** `null` marks an ambiguous key (seen from more than one prompt). */
  private map = new Map<string, ResolvedPrompt | null>();

  /**
   * Rebuilds the map from scratch by scanning every provider's prompts. Call
   * after the initial load and whenever a provider's prompts change.
   */
  async rebuild(providers: Map<string, PromptProvider>): Promise<void> {
    const next = new Map<string, ResolvedPrompt | null>();
    for (const [providerId, provider] of providers) {
      const prompts = await provider.getAllPrompts();
      for (const prompt of prompts) {
        this.register(next, prompt.id, { providerId, promptId: prompt.id });
        if (prompt.globalId) {
          this.register(next, prompt.globalId, { providerId, promptId: prompt.id });
        }
      }
    }
    this.map = next;
  }

  private register(map: Map<string, ResolvedPrompt | null>, key: string, value: ResolvedPrompt): void {
    if (map.has(key)) {
      // Collision: the key can't unambiguously identify a single prompt.
      map.set(key, null);
    } else {
      map.set(key, value);
    }
  }

  /**
   * Resolves a {@link PromptID} to a provider-scoped reference, or `undefined`
   * when it can't be resolved.
   *
   * The map is always consulted first: it translates a (possibly global) `id`
   * into the real provider-scoped prompt ID the provider can actually open.
   * Only when the map has nothing (absent, or ambiguous) do we fall back to
   * trusting `providerId` together with `id` as already provider-scoped.
   */
  resolve(id: string, providerId?: string): ResolvedPrompt | undefined {
    const entry = this.map.get(id);
    if (entry) return entry;
    return providerId ? { providerId, promptId: id } : undefined;
  }
}
