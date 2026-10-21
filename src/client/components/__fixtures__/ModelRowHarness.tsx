// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import type { PropDefinition, PropValue } from "../../../shared/types";
import ModelRow from "../ModelRow";

const IMPORT = {
  kind: "import",
  spec: { name: "openai", from: "@ai-sdk/openai" },
} as const;

/** A model slot with one preset, carrying binding candidates as real presets do. */
const PRESET_MODEL_DEFINITION: PropDefinition = {
  name: "model",
  type: { kind: "primitive", syntax: "string", base: "string" },
  optional: false,
  catalogs: [
    {
      label: "Provider",
      groups: [
        {
          label: "OpenAI",
          presets: [
            {
              label: "GPT-5.5",
              value: {
                kind: "functionCall",
                callee: "openai",
                args: [{ kind: "primitive", value: "gpt-5.5" }],
                binding: [{ kind: "parameter" }, IMPORT],
              },
            },
          ],
        },
      ],
    },
  ],
};

/** What the server reads back once a value is written: one binding, the one used. */
function readBack(value: PropValue): PropValue {
  return value.kind === "functionCall" && Array.isArray(value.binding)
    ? { ...value, binding: IMPORT }
    : value;
}

/**
 * Mounts {@link ModelRow} on a value saved straight away, read back as the
 * server would, with a button that changes the model from elsewhere (another
 * tab, a ref switch).
 */
export function ModelRowHarness() {
  const [value, setValue] = useState<PropValue>({
    kind: "primitive",
    value: "vendor/start",
  });
  return (
    <div style={{ width: 600 }}>
      <ModelRow
        definition={PRESET_MODEL_DEFINITION}
        value={value}
        editable
        onChange={v => setValue(readBack(v))}
      />
      <button
        type="button"
        onClick={() => setValue({ kind: "primitive", value: "vendor/other" })}
      >
        Change elsewhere
      </button>
    </div>
  );
}
