// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { PromptInputSources, ResourceInfo } from "../../../shared/types";
import { ResourcesSection } from "../ResourcesSection";
import type { InstanceSelections } from "../run-resources-state";
import "../../styles.css";

const CATALOG: ResourceInfo[] = [
  { uri: "db.ts#db", label: "db", scope: "run" },
  { uri: "cache.ts#cache", label: "cache", scope: "server" },
];

const SOURCES: PromptInputSources = {
  resources: CATALOG,
  functionSlots: {},
  executeSlots: {},
};

const INITIAL: InstanceSelections = {
  db: { uri: "db.ts#db", args: {} },
  cache: { uri: "cache.ts#cache", args: {} },
};

/**
 * Mounts {@link ResourcesSection} with a `db` run resource and a `cache`
 * server resource. Only `db` is referenced, so removing it asks first. The
 * current instance names are in `[data-testid="names"]`.
 */
export function ResourcesSectionHarness() {
  const [instances, setInstances] = useState(INITIAL);
  return (
    <div>
      <ResourcesSection
        instances={instances}
        onChange={next =>
          setInstances(latest =>
            typeof next === "function" ? next(latest) : next,
          )
        }
        sources={SOURCES}
        catalog={CATALOG}
        referencedBy={name => (name === "db" ? ["taskId"] : [])}
      />
      <span data-testid="names">{Object.keys(instances).join(",")}</span>
    </div>
  );
}
