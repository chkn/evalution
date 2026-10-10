// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useMemo } from "react";
import { ItemEditor } from "ts-proppy/react";
import { jsonToPropValue } from "../../shared/json-prop-value";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import { isPseudoUri } from "./pseudo-sources";
import SourcePicker from "./SourcePicker";
import type { SourceContext } from "./source-context";
import { combinedLabel } from "./source-tree";

/**
 * The chip's label for `selected` — its own label alone, or, for an output
 * value, `"Resource → Output"` (the same composite the dropdown row uses to
 * name it — see `source-tree.ts`'s `resolveResource`), even when that
 * output is the only one its resource declares: the chip has no submenu
 * tree beside it to say which resource this came from, so the label says
 * so itself.
 */
function chipLabel(
  selected: ResourceInfo,
  resourcesByUri: ReadonlyMap<string, ResourceInfo>,
): string {
  if (!selected.parent) return selected.label;
  const parent = resourcesByUri.get(selected.parent);
  return parent ? combinedLabel(parent.label, selected.label) : selected.label;
}

/** `ItemEditor` needs an `onChange` even for the read-only preview — `disabled` already keeps it from ever firing. */
function noop() {}

/**
 * A slot's source dropdown and the control beneath it.
 *
 * With a source chosen the editor is replaced — by a read-only preview of a
 * catalog resource's value where the server already has one to show (see
 * `ResourceInfo.value`), or otherwise by a chip naming it: one of the run's
 * resource instances (`◆ root.taskId`), a column, or another slot. A chip is
 * only a reference: an instance's arguments live on its card in the
 * Resources section, which the chip opens.
 *
 * Shared by {@link ExecutionInputEditor} (a slot's own row and every nested
 * one) and {@link CombinedInputEditor} (one row per deduped group) so both
 * modes render the identical control.
 */
export function SourceRow({
  propDef,
  resources,
  matching,
  chosen,
  onChoose,
  context,
  children,
}: {
  propDef: PropDefinition;
  /** Every source offered to the prompt, unfiltered — for the picker's group/value tree. */
  resources: readonly ResourceInfo[];
  matching: ResourceInfo[];
  chosen: string | undefined;
  onChoose: (uri: string | null) => void;
  /** See {@link SourceContext}. */
  context?: SourceContext;
  children: React.ReactNode;
}) {
  const editable = propDef.type.kind !== "opaque";
  const selected = chosen ? matching.find(r => r.uri === chosen) : undefined;
  const pseudo =
    chosen && isPseudoUri(chosen)
      ? (context?.describePseudo?.(chosen, propDef.type) ?? { note: "" })
      : undefined;
  // A stored choice whose source is gone — renamed, deleted, or in a module
  // that now fails to load. It stays listed, and selected, because it is still
  // what a run would send: dropping it silently would show an editor while
  // submitting the source behind it.
  const stale = chosen && !selected && !pseudo?.label ? chosen : undefined;

  const resourcesByUri = useMemo(
    () => new Map(resources.map(r => [r.uri, r])),
    [resources],
  );

  if (matching.length === 0 && !stale && !pseudo && editable) {
    return <>{children}</>;
  }

  const pseudoLabel = pseudo
    ? (pseudo.label ??
      (selected ? chipLabel(selected, resourcesByUri) : undefined))
    : undefined;

  return (
    <div className="pg-slot">
      <div className="pg-slot-body">
        {editable && selected?.value !== undefined ? (
          // The real value beats naming it: only a live handle or a run-only
          // resource (no `ResourceInfo.value` — see `ResourceRegistry.describe`)
          // falls back to a chip. An instance of a static resource is that
          // value, so it's previewed too.
          <div className="pg-slot-preview" title={selected.uri}>
            <ItemEditor
              propDef={propDef}
              value={jsonToPropValue(selected.value)}
              onChange={noop}
              disabled
            />
          </div>
        ) : pseudo && pseudoLabel !== undefined ? (
          <span
            className={
              "pg-slot-chip pg-slot-chip-pseudo" +
              (pseudo.warning || pseudo.missing ? " pg-slot-chip-warning" : "")
            }
            title={
              pseudo.warning ? `Type mismatch: ${pseudo.warning}` : undefined
            }
          >
            {pseudo.onOpen ? (
              <button
                type="button"
                className="pg-slot-instance-link"
                title="Show this resource"
                onClick={pseudo.onOpen}
              >
                ◆ {pseudoLabel}
              </button>
            ) : (
              pseudoLabel
            )}
            {(pseudo.warning || pseudo.note) && (
              <em className="pg-slot-chip-note">
                {pseudo.warning ? `⚠ ${pseudo.warning}` : pseudo.note}
              </em>
            )}
          </span>
        ) : selected ? (
          <span className="pg-slot-chip" title={selected.uri}>
            {chipLabel(selected, resourcesByUri)}
            <em className="pg-slot-chip-note">
              {selected.scope === "server"
                ? "created once per server"
                : "created for each run"}
            </em>
          </span>
        ) : stale ? (
          <div className="pg-slot-hint">
            <span>Resource no longer available</span>
          </div>
        ) : editable ? (
          children
        ) : (
          // The type already appears in this slot's own label, right above —
          // repeating it here would just be noise.
          <div className="pg-slot-hint">
            <span>No editor for this type</span>
            {/* TODO: point at real docs once they exist. */}
            <a
              className="pg-slot-hint-help"
              href="https://example.com/docs/opaque-types"
              target="_blank"
              rel="noreferrer"
              aria-label="Learn more about opaque types"
            >
              ?
            </a>
          </div>
        )}
      </div>

      {/* An opaque slot has no editor to fall back to, so its picker offers
          no "Custom" — picking a source is the only way to fill it. */}
      {(matching.length > 0 || stale || pseudo) && (
        <SourcePicker
          resources={resources}
          matching={matching}
          chosen={chosen}
          stale={stale}
          editable={editable}
          label={propDef.name}
          onChoose={onChoose}
        />
      )}
    </div>
  );
}
