// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropType } from "../../shared/types";

/** What a chip for a pseudo-source says — see {@link SourceContext.describePseudo}. */
export interface PseudoDescription {
  /** The chip's own label, when it should differ from the picker entry's. */
  label?: string;
  /** The note beneath the label. */
  note: string;
  /** Set when the source's type doesn't fit the slot's: `"string into number"`. */
  warning?: string;
  /** Set when the source no longer exists — a removed instance, say. */
  missing?: boolean;
  /** Brings what the chip names into view: an instance's card. */
  onOpen?: () => void;
}

/**
 * What a slot's editor needs from its host beyond its own selection: how to
 * describe a chip for a column, another slot or a resource instance, and how
 * to turn a pick from the resource catalog into an instance of the run.
 * Threaded unchanged through `ExecutionInputEditor` and `CombinedInputEditor`
 * as one prop. See `specs/resource-instances.md` §G, §H.
 */
export interface SourceContext {
  /**
   * What a chip for pseudo-source `uri` says in a slot of `slotType`.
   * Absent where no pseudo-source is offered.
   */
  describePseudo?: (
    uri: string,
    slotType: PropType,
  ) => PseudoDescription | undefined;
  /**
   * Turns a pick from the resource catalog into a reference to one of the
   * run's instances — adding one, usually — and returns that reference's
   * pseudo-source URI, which is what the slot then holds. Absent where the
   * host offers no catalog.
   */
  adopt?: (uri: string) => string;
}
