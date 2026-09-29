// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  FieldValues,
  NormalizedPromptUpdates,
  PendingConflicts,
  VariationId,
  VariationInfo,
  VersionId,
} from "../../shared/types.ts";

/** A variation as stored: {@link VariationInfo} plus what only the store needs. */
export interface StoredVariation extends VariationInfo {
  /**
   * The prompt's `prompts()` id when it has one, so a rebase can find the
   * prompt at head after a file move or an export rename.
   */
  globalId?: string;
  /**
   * The prompt's values for the fields {@link updates} sets, as they were
   * when it was made — the base of the three-way merge that carries it onto
   * a changed working tree. See `fieldValuesOf`.
   */
  baseValues: FieldValues;
}

/** What identifies a variation's content. */
export interface VariationContent {
  promptId: string;
  globalId?: string;
  base?: VersionId;
  /** Canonical updates — see `canonicalizeUpdates`. */
  updates: NormalizedPromptUpdates;
  baseValues: FieldValues;
}

/** A new WIP variation. */
export interface NewWip extends VariationContent {
  /** Whether this WIP holds the unsaved edits to head. At most one per prompt. */
  onHead: boolean;
  /** The name of the variation it was opened from, if any. */
  originName?: string;
}

/** Changes to a WIP. Omitted fields are left alone; `null` clears. */
export interface WipChanges {
  updates?: NormalizedPromptUpdates;
  baseValues?: FieldValues;
  pending?: PendingConflicts | null;
  originName?: string | null;
}

/**
 * Where a {@link FilePromptProvider} keeps variations: immutable ("frozen")
 * ones, deduplicated by content, the one mutable WIP of unsaved edits to
 * head per prompt, and one per (prompt, old version).
 *
 * Nothing is garbage-collected: frozen rows are minted only when something
 * runs or gets a name, and they dedupe. See
 * `specs/prompt-versions-and-variations.md` §E.
 */
export interface VariationStore {
  /** The variation with this id, frozen or WIP. */
  get(id: VariationId): Promise<StoredVariation | undefined>;
  /**
   * Inserts a frozen variation, or returns the existing one with the same
   * content.
   */
  intern(v: VariationContent): Promise<StoredVariation>;
  /** The WIP of unsaved edits to an old version of a prompt, if any. */
  getWip(
    promptId: string,
    base: VersionId,
  ): Promise<StoredVariation | undefined>;
  /** The WIP holding a prompt's unsaved edits to head, if any. */
  getHeadWip(promptId: string): Promise<StoredVariation | undefined>;
  /** Every head WIP, of every prompt — what the dirty indicators come from. */
  listHeadWips(): Promise<StoredVariation[]>;
  /** Creates a WIP, replacing any that holds the same slot. */
  putWip(v: NewWip): Promise<StoredVariation>;
  /** Changes a WIP in place — to edit it, rebase it, or record conflicts. */
  updateWip(id: VariationId, changes: WipChanges): Promise<StoredVariation>;
  /** Deletes a WIP. A frozen variation is never deleted. */
  deleteWip(id: VariationId): Promise<void>;
  /** A prompt's named variations and its WIPs. */
  list(promptId: string): Promise<StoredVariation[]>;
  /** Names a frozen variation. A name is unique per prompt; naming again moves it. */
  name(id: VariationId, promptId: string, name: string): Promise<void>;
  /** Removes a name. */
  unname(promptId: string, name: string): Promise<void>;
}
