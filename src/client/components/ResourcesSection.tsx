// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useMemo, useState } from "react";
import type { PromptInputSources, ResourceInfo } from "../../shared/types";
import { ExecutionInputEditor } from "./ExecutionInputEditor";
import { describeInstanceSource, parseInstanceUri } from "./pseudo-sources";
import {
  addInstance,
  derivedDependencies,
  duplicateInstance,
  excludedFromArgs,
  type InstanceSelections,
  instanceNameProblem,
  removeInstance,
  renameInstance,
} from "./run-resources-state";
import SourcePicker from "./SourcePicker";
import type { SourceContext } from "./source-context";

/**
 * A change to the run's instances that the host has to carry into its own
 * slots too: references to a renamed instance follow it, and references to a
 * removed one are cleared (see `retargetSelections`).
 */
export type InstanceEdit =
  | { kind: "rename"; from: string; to: string }
  | { kind: "remove"; name: string };

/** How long a card stays flagged `.pg-row-highlight` after {@link scrollToInstance} lands on it. */
const HIGHLIGHT_MS = 1200;

/**
 * Scrolls instance `name`'s card into view and briefly flashes it — what a
 * chip naming the instance does when clicked.
 */
export function scrollToInstance(name: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-instance-card="${CSS.escape(name)}"]`,
  );
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Removing the class and forcing a reflow restarts the animation, so a
  // repeat click flashes again.
  el.classList.remove("pg-row-highlight");
  void el.offsetWidth;
  el.classList.add("pg-row-highlight");
  window.setTimeout(
    () => el.classList.remove("pg-row-highlight"),
    HIGHLIGHT_MS,
  );
}

interface Props {
  /** The run's instances, by name, in display order. */
  instances: InstanceSelections;
  /**
   * Called with the next instances (or how to get them from the latest —
   * an argument pick from the catalog adds an instance through
   * `context.adopt` just before), and with the edit when slots must follow
   * it.
   */
  onChange: (
    next:
      | InstanceSelections
      | ((latest: InstanceSelections) => InstanceSelections),
    edit?: InstanceEdit,
  ) => void;
  /**
   * Every source the host's slots are offered — instances, columns and
   * prompt slots included — whose `resourceSlots` say what fits each
   * argument.
   */
  sources: PromptInputSources;
  /** The resources an instance can be created from: the prompt's own `inputSources.resources`. */
  catalog: readonly ResourceInfo[];
  /** What references instance `name` (`taskId`, `child1.parentId`) — see `referencesTo`. */
  referencedBy: (name: string) => string[];
  /** Forwarded to each argument's editor. */
  context?: SourceContext;
}

/**
 * The run's named resource instances, one card each, above the slots: its
 * name, its resource, what references it, and its argument form. Then the
 * dependencies the run doesn't declare, which are created with no arguments
 * and shared. Controlled: the host persists `instances` however it persists
 * the rest of its inputs. See `specs/resource-instances.md` §G.
 */
export function ResourcesSection({
  instances,
  onChange,
  sources,
  catalog,
  referencedBy,
  context,
}: Props) {
  const catalogByUri = useMemo(
    () => new Map(catalog.map(r => [r.uri, r])),
    [catalog],
  );
  const named = Object.entries(instances);
  const dependencies = derivedDependencies(instances, catalogByUri);

  // Only resources themselves, not their outputs; a server-scoped one that
  // already has an instance can't have a second.
  const addable = catalog.filter(
    r =>
      !r.parent &&
      !r.error &&
      !(
        (r.scope === "server" || r.value !== undefined) &&
        named.some(([, i]) => i.uri === r.uri)
      ),
  );

  const add = (uri: string | null) => {
    if (!uri) return;
    onChange(addInstance(instances, uri).instances);
  };

  return (
    <section className="pg-resources" aria-label="Resources">
      <div className="pg-resources-header">
        <span className="pg-resources-title">Resources</span>
        {addable.length > 0 && (
          <SourcePicker
            resources={catalog}
            matching={addable}
            chosen={undefined}
            stale={undefined}
            editable={false}
            label="Resources"
            triggerLabel="＋ Add resource"
            onChoose={add}
          />
        )}
      </div>
      {named.map(([name, instance]) => (
        <InstanceCard
          key={name}
          name={name}
          instances={instances}
          resource={catalogByUri.get(instance.uri)}
          onChange={onChange}
          sources={sources}
          referencedBy={referencedBy(name)}
          context={context}
        />
      ))}
      {dependencies.map(dep => {
        const info = catalogByUri.get(dep.uri);
        return (
          <div
            className="pg-resource-card pg-resource-dependency"
            key={dep.uri}
          >
            <div className="pg-resource-head">
              <span className="pg-resource-name">
                ◆ {info?.label ?? dep.uri}
              </span>
              <span className="pg-resource-meta">
                {scopeLabel(info)} · dependency
              </span>
              {!dep.ambiguous && (
                <button
                  type="button"
                  className="pg-resource-action"
                  title="Add it to the run, to give it arguments or a name"
                  onClick={() => add(dep.uri)}
                >
                  Configure
                </button>
              )}
            </div>
            <div
              className={
                "pg-resource-refs" +
                (dep.ambiguous ? " pg-resource-refs-warning" : "")
              }
            >
              {dep.ambiguous
                ? `⚠ ${dep.usedBy.join(", ")} can't tell which to use: ${dep.ambiguous.join(", ")}`
                : `used by ${dep.usedBy.join(", ")}`}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** "shared" for a resource created once per server, "per run" otherwise. */
function scopeLabel(info: ResourceInfo | undefined): string {
  return info?.scope === "server" ? "shared" : "per run";
}

function InstanceCard({
  name,
  instances,
  resource,
  onChange,
  sources,
  referencedBy,
  context,
}: {
  name: string;
  instances: InstanceSelections;
  resource: ResourceInfo | undefined;
  onChange: Props["onChange"];
  sources: PromptInputSources;
  referencedBy: string[];
  context?: SourceContext;
}) {
  const instance = instances[name];
  const [draftName, setDraftName] = useState<string | null>(null);
  const problem =
    draftName === null
      ? undefined
      : instanceNameProblem(draftName, instances, name);

  const commitRename = () => {
    if (draftName === null) return;
    if (!problem && draftName !== name) {
      onChange(renameInstance(instances, name, draftName), {
        kind: "rename",
        from: name,
        to: draftName,
      });
    }
    setDraftName(null);
  };

  const remove = () => {
    if (
      referencedBy.length > 0 &&
      !window.confirm(
        `Remove '${name}'? ${referencedBy.join(", ")} will be cleared.`,
      )
    ) {
      return;
    }
    onChange(removeInstance(instances, name), { kind: "remove", name });
  };

  // An argument may name any other instance whose creation doesn't need
  // this one first.
  const excluded = excludedFromArgs(instances, name);
  const argSlots = Object.fromEntries(
    Object.entries(sources.resourceSlots?.[instance.uri] ?? {}).map(
      ([path, uris]) => [
        path,
        uris.filter(uri => {
          const ref = parseInstanceUri(uri);
          return !ref || !excluded.has(ref.name);
        }),
      ],
    ),
  );
  const params = resource?.parameters ?? [];

  return (
    <div className="pg-resource-card" data-instance-card={name}>
      <div className="pg-resource-head">
        {draftName === null ? (
          <button
            type="button"
            className="pg-resource-name pg-resource-rename"
            title="Rename"
            onClick={() => setDraftName(name)}
          >
            ◆ {name} <span aria-hidden="true">✎</span>
          </button>
        ) : (
          <input
            className="pg-resource-name-input"
            aria-label={`Name for ${name}`}
            aria-invalid={!!problem}
            title={problem}
            value={draftName}
            autoFocus
            onChange={e => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setDraftName(null);
            }}
          />
        )}
        <span className="pg-resource-meta" title={instance.uri}>
          {resource ? resource.label : "Resource no longer available"}
          {resource && ` · ${scopeLabel(resource)}`}
        </span>
        <span className="pg-resource-actions">
          {resource?.scope !== "server" && (
            <button
              type="button"
              className="pg-resource-action"
              onClick={() =>
                onChange(duplicateInstance(instances, name).instances)
              }
            >
              Duplicate
            </button>
          )}
          <button
            type="button"
            className="pg-resource-action"
            aria-label={`Remove ${name}`}
            onClick={remove}
          >
            Remove
          </button>
        </span>
      </div>
      {problem && <div className="pg-resource-refs-warning">{problem}</div>}
      <div className="pg-resource-refs">
        {referencedBy.length > 0
          ? `→ ${referencedBy.join(", ")}`
          : "not bound to a slot: runs for its side effects"}
      </div>
      {params.length > 0 && (
        <div className="pg-args-form">
          {params.map(param => (
            <div className="pg-args-row" key={param.name}>
              <span className="pg-args-name">{param.name}</span>
              <ExecutionInputEditor
                propDef={param}
                selection={instance.args[param.name] ?? {}}
                onChange={next =>
                  onChange(latest => {
                    const current = latest[name];
                    if (!current) return latest;
                    return {
                      ...latest,
                      [name]: {
                        ...current,
                        args: { ...current.args, [param.name]: next },
                      },
                    };
                  })
                }
                resources={sources.resources}
                slots={argSlots}
                context={context}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The {@link SourceContext} a host hands its slots and the section's own
 * argument forms: instance chips name the instance and open its card, a pick
 * from the catalog adds an instance, and every other pseudo-source is
 * described by `describeOther` (columns, prompt slots).
 */
export function instanceSourceContext({
  instances,
  catalogByUri,
  adopt,
  describeOther,
}: {
  instances: InstanceSelections;
  catalogByUri: ReadonlyMap<string, ResourceInfo>;
  adopt: (uri: string) => string;
  describeOther?: SourceContext["describePseudo"];
}): SourceContext {
  return {
    adopt,
    describePseudo: (uri, slotType) => {
      const instance = describeInstanceSource(uri, instances, catalogByUri);
      if (!instance) return describeOther?.(uri, slotType);
      const ref = parseInstanceUri(uri)!;
      return {
        ...instance,
        ...(!instance.missing && { onOpen: () => scrollToInstance(ref.name) }),
      };
    },
  };
}
