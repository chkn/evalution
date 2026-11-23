// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useRef, useState } from "react";
import type { PropDefinition, ResourceInfo } from "../../../shared/types";
import { ExecutionInputEditor } from "../ExecutionInputEditor";
import type { SlotSelection } from "../execution-input-state";
import "../../styles.css";

const AFTER: PropDefinition = {
  name: "after",
  optional: false,
  type: {
    kind: "array",
    syntax: "TaskId[]",
    element: {
      name: "",
      optional: false,
      type: { kind: "primitive", syntax: "TaskId", base: "string" },
    },
  },
};

const RESOURCES: ResourceInfo[] = [
  { uri: "pg.ts#root", label: "root", scope: "run" },
  { uri: "pg.ts#forge", label: "forge", scope: "run" },
];

const text = (value: string) => ({ kind: "primitive" as const, value });

/**
 * Mounts an {@link ExecutionInputEditor} for a `TaskId[]` slot whose three
 * elements are a typed-in id, then `root`, then `forge`. The slot's chosen
 * sources, by path, are in `[data-testid="resources"]`; every selection
 * the editor has reported is in `[data-testid="reported"]`.
 */
export function ArrayBindingsHarness() {
  const [selection, setSelection] = useState<SlotSelection>({
    value: { kind: "array", elements: [text("tsk_typed"), text(""), text("")] },
    resources: { "1": "pg.ts#root", "2": "pg.ts#forge" },
  });
  const reported = useRef<SlotSelection[]>([]);
  return (
    <div>
      <ExecutionInputEditor
        propDef={AFTER}
        selection={selection}
        onChange={next => {
          reported.current.push(next);
          setSelection(next);
        }}
        resources={RESOURCES}
        slots={{ "after.[]": RESOURCES.map(r => r.uri) }}
      />
      <span data-testid="resources">
        {JSON.stringify(selection.resources ?? {})}
      </span>
      <span data-testid="reported">{JSON.stringify(reported.current)}</span>
    </div>
  );
}
