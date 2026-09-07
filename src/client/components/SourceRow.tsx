// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { ItemEditor } from "ts-proppy/react";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import { jsonToPropValue } from "./json-to-prop-value";

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
  matching,
  chosen,
  onChoose,
  children,
}: {
  propDef: PropDefinition;
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

      {/* Styled as an icon-only button — same size and alignment as the
          array editor's per-item remove button — with the real `<select>`
          stretched over it invisibly so the native picker still opens on
          click. */}
      {(matching.length > 0 || stale) && (
        <div className="pg-slot-source-wrap">
          <span className="pg-slot-source-icon" aria-hidden="true">
            ⋯
          </span>
          <select
            className="pg-slot-source"
            value={chosen ?? ""}
            onChange={e => onChoose(e.target.value || null)}
            aria-label={`Source for ${propDef.name}`}
            title="Pick a resource"
          >
            {/* An opaque slot has no editor to fall back to, so it offers no
                "Custom" — picking a source is the only way to fill it. */}
            {editable && <option value="">Custom</option>}
            {!editable && !chosen && <option value="">Pick a resource…</option>}
            {matching.map(r => (
              <option key={r.uri} value={r.uri}>
                {r.label}
              </option>
            ))}
            {stale && <option value={stale}>{stale} (unavailable)</option>}
          </select>
        </div>
      )}
    </div>
  );
}
