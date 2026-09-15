// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useMemo } from "react";
import { ItemEditor } from "ts-proppy/react";
import type { PropDefinition, ResourceInfo } from "../../shared/types";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import { rootResourceUri, type Selections } from "./execution-input-state";
import { jsonToPropValue } from "./json-to-prop-value";
import {
  MAX_RESOURCE_ARG_DEPTH,
  nested,
  type ResourceArgsContext,
} from "./resource-args-context";
import SourcePicker from "./SourcePicker";
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

/** How long a row stays flagged `.pg-row-highlight` after `scrollToRow` lands on it. */
const HIGHLIGHT_MS = 1200;

/**
 * Scrolls the row identified by `path` (the same string `SourceRow` tags its
 * own `.pg-slot` with, via `data-row-path`) into view and briefly flashes it
 * — what the chip's "same instance as ▲ X" link does, so picking the same
 * resource twice reads as "here's the other one", not just a name.
 */
function scrollToRow(path: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-row-path="${CSS.escape(path)}"]`,
  );
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Restarts the animation even if this row was just highlighted and hasn't
  // finished fading — removing the class and forcing a reflow before adding
  // it back is what makes a repeat click flash again instead of no-op-ing.
  el.classList.remove("pg-row-highlight");
  void el.offsetWidth;
  el.classList.add("pg-row-highlight");
  window.setTimeout(
    () => el.classList.remove("pg-row-highlight"),
    HIGHLIGHT_MS,
  );
}

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
 * When the chosen resource declares `parameters` (`specs/resource-arguments.md`
 * §B), its argument form renders as a block beneath the chip — see
 * {@link ResourceArgumentsForm}.
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
  argsContext,
  children,
}: {
  propDef: PropDefinition;
  /** Every source offered to the prompt, unfiltered — for the picker's group/value tree. */
  resources: readonly ResourceInfo[];
  matching: ResourceInfo[];
  chosen: string | undefined;
  onChoose: (uri: string | null) => void;
  /** See {@link ResourceArgsContext}. Absent means no argument form is ever rendered. */
  argsContext?: ResourceArgsContext;
  children: React.ReactNode;
}) {
  const editable = propDef.type.kind !== "opaque";
  const selected = chosen ? matching.find(r => r.uri === chosen) : undefined;
  // A stored choice whose resource is gone — renamed, deleted, or in a module
  // that now fails to load. It stays listed, and selected, because it is still
  // what a run would send: dropping it silently would show an editor while
  // submitting the resource behind it.
  const stale = chosen && !selected ? chosen : undefined;

  // A resource already selected by an earlier row is the *same instance*
  // here too (§I), whether or not it takes arguments — the chip says so
  // instead of repeating "created once per server"/"created for each run",
  // which would otherwise wrongly imply a second one gets made.
  const resourcesByUri = useMemo(
    () => new Map(resources.map(r => [r.uri, r])),
    [resources],
  );
  const sharedWith =
    selected && argsContext
      ? argsContext.claimed.get(rootResourceUri(selected.uri, resourcesByUri))
      : undefined;
  const sameInstanceAs =
    sharedWith && sharedWith.path !== argsContext?.path
      ? sharedWith
      : undefined;

  if (matching.length === 0 && !stale && editable) return <>{children}</>;

  const row = (
    <div className="pg-slot" data-row-path={argsContext?.path}>
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
              {chipLabel(selected, resourcesByUri)}
              <em className="pg-slot-chip-note">
                {sameInstanceAs ? (
                  <>
                    same instance as{" "}
                    <button
                      type="button"
                      className="pg-slot-instance-link"
                      title={`Scroll to ${sameInstanceAs.label} above`}
                      aria-label={`Scroll to ${sameInstanceAs.label} above`}
                      onClick={() => scrollToRow(sameInstanceAs.path)}
                    >
                      {sameInstanceAs.label} <span aria-hidden="true">▲</span>
                    </button>
                  </>
                ) : selected.scope === "server" ? (
                  "created once per server"
                ) : (
                  "created for each run"
                )}
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

  const argsForm =
    selected && argsContext ? (
      <ResourceArgumentsForm
        selected={selected}
        resources={resources}
        resourcesByUri={resourcesByUri}
        argsContext={argsContext}
      />
    ) : null;

  if (!argsForm) return row;
  return (
    <div className="pg-slot-stack">
      {row}
      {argsForm}
    </div>
  );
}

/**
 * The block beneath a chosen resource's chip: its own argument editors, only
 * for the row that owns its first selection (`specs/resource-arguments.md`
 * §I's "one binding per resource per prompt" rule) — every other selection
 * of the same resource already says so on its chip (see `sameInstanceAs` in
 * {@link SourceRow}), so it takes no space here at all. Ownership itself is
 * decided elsewhere, purely, by `computeClaims` — this only reads the answer
 * (by comparing full paths, not bare names — two rows can easily share a
 * name, like a prompt's own `taskId` and some other resource's own `taskId`
 * argument), which is what keeps it safe to call twice (React StrictMode)
 * without the two calls disagreeing.
 */
function ResourceArgumentsForm({
  selected,
  resources,
  resourcesByUri,
  argsContext,
}: {
  selected: ResourceInfo;
  resources: readonly ResourceInfo[];
  /** `resources`, by `uri`. */
  resourcesByUri: ReadonlyMap<string, ResourceInfo>;
  argsContext: ResourceArgsContext;
}) {
  // `selected` may be one of the resource's own output values
  // (`seededTask.taskId`) rather than the resource itself — only the root
  // carries `parameters`, and the args form (and its state) belongs to the
  // root regardless of which value was actually picked for this slot, so
  // that `seededTask.taskId` here and `seededTask.title` on another slot
  // share one set of arguments (§I).
  const root =
    resourcesByUri.get(rootResourceUri(selected.uri, resourcesByUri)) ??
    selected;

  const params = root.parameters;
  if (!params || params.length === 0) return null;
  if (argsContext.depth >= MAX_RESOURCE_ARG_DEPTH) return null;

  const claimedBy = argsContext.claimed.get(root.uri);
  // No owner found is defensive only (computeClaims should always have
  // visited whatever's actually selected) — default to rendering rather than
  // hiding, so a gap in that computation never silently loses editability.
  if (claimedBy && claimedBy.path !== argsContext.path) {
    return null;
  }

  const slots = argsContext.resourceSlots[root.uri] ?? {};
  const selections = argsContext.resourceArgs[root.uri] ?? {};
  const setSelections = (next: Selections) =>
    argsContext.onResourceArgsChange(root.uri, next);

  return (
    <div className="pg-args-form">
      {params.map(param => (
        <div className="pg-args-row" key={param.name}>
          <span className="pg-args-name">{param.name}</span>
          <ExecutionInputEditor
            propDef={param}
            selection={selections[param.name] ?? {}}
            onChange={next =>
              setSelections({ ...selections, [param.name]: next })
            }
            resources={resources}
            slots={slots}
            argsContext={nested(argsContext, `args.${param.name}`)}
          />
        </div>
      ))}
    </div>
  );
}
