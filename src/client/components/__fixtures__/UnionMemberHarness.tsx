// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { PropsEditor } from "ts-proppy/react";
import type { PropDefinition, PropValue } from "../../../shared/types";

// Mirrors the shape that sent us here (`string | null`), a union mixing
// constants with an open-ended member, and one with several open-ended
// members and no constants at all.
const DEFINITIONS: PropDefinition[] = [
  {
    name: "description",
    optional: true,
    type: {
      kind: "union",
      syntax: "string | null",
      types: [
        { kind: "primitive", syntax: "string" },
        { kind: "constant", syntax: "null", value: null },
      ],
    },
  },
  {
    name: "width",
    optional: false,
    type: {
      kind: "union",
      syntax: "'auto' | 'none' | number",
      types: [
        { kind: "constant", syntax: "'auto'", value: "auto" },
        { kind: "constant", syntax: "'none'", value: "none" },
        { kind: "primitive", syntax: "number" },
      ],
    },
  },
  {
    name: "seed",
    optional: false,
    type: {
      kind: "union",
      syntax: "string | number",
      types: [
        { kind: "primitive", syntax: "string" },
        { kind: "primitive", syntax: "number" },
      ],
    },
  },
];

/**
 * Renders {@link PropsEditor} over union-typed parameters and dumps the
 * resulting values as JSON so a test can assert what reached `onChange` — in
 * particular that a chosen constant keeps its own type rather than arriving
 * stringified.
 */
export function UnionMemberHarness() {
  const [values, setValues] = useState<Record<string, PropValue>>({});
  return (
    <div>
      <PropsEditor
        props={{ definitions: DEFINITIONS, values }}
        onChange={(name, value) =>
          setValues(prev => ({ ...prev, [name]: value }))
        }
      />
      <pre data-testid="values">{JSON.stringify(values)}</pre>
    </div>
  );
}
