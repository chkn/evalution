// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { ItemEditor } from "ts-proppy/react";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import { jsonToPropValue } from "./json-to-prop-value";
import SourcePicker from "./SourcePicker";

/** `ItemEditor` needs an `onChange` even for the read-only preview — `disabled` already keeps it from ever firing. */
function noop() {}

/**
 * A slot's source dropdown and the control beneath it.
 *
 * With a resource chosen the editor is replaced — by a read-only preview of
 * the resource's value where the server already has one to show (see
 * `ResourceInfo.value`), or otherwise by a chip naming the resource. Most
 * resources' values don't exist until the run creates them, which is when a
 * chip is all there is to show. (Seeding an editor from a stored value is
 * what a dataset row is for.)
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
  children,
}: {
  propDef: PropDefinition;
  /** Every source offered to the prompt, unfiltered — for the picker's group/value tree. */
  resources: readonly ResourceInfo[];
  matching: ResourceInfo[];
  chosen: string | undefined;
  onChoose: (uri: string | null) => void;
  children: React.ReactNode;
}) {
  const editable = propDef.type.kind !== "opaque";
  const selected = chosen ? matching.find(r => r.uri === chosen) : undefined;
  // A stored choice whose resource is gone — renamed, deleted, or in a module
  // that now fails to load. It stays listed, and selected, because it is still
  // what a run would send: dropping it silently would show an editor while
  // submitting the resource behind it.
  const stale = chosen && !selected ? chosen : undefined;

  if (matching.length === 0 && !stale && editable) return <>{children}</>;

  return (
    <div className="pg-slot">
      <div className="pg-slot-body">
        {selected ? (
          // The real value beats naming it: only a live handle or a run-only
          // resource (no `ResourceInfo.value` — see `ResourceRegistry.describe`)
          // falls back to the chip.
          editable && selected.value !== undefined ? (
            <div className="pg-slot-preview" title={selected.uri}>
              <ItemEditor
                propDef={propDef}
                value={jsonToPropValue(selected.value)}
                onChange={noop}
                disabled
              />
            </div>
          ) : (
            <span className="pg-slot-chip" title={selected.uri}>
              {selected.label}
              <em className="pg-slot-chip-note">
                {selected.scope === "server"
                  ? "created once per server"
                  : "created for each run"}
              </em>
            </span>
          )
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
      {(matching.length > 0 || stale) && (
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
