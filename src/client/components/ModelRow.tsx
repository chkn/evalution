// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useRef, useState } from "react";
import {
  CatalogIconContext,
  ItemEditor,
  valueToDisplayString,
} from "ts-proppy/react";
import type { PropDefinition, PropValue } from "../../shared/types";
import { EDIT_SAVE_DELAY_MS } from "./edit-save-delay";
import ProviderIcon from "./ProviderIcon";

const renderIcon = (icon: string | undefined, size: number) => (
  <ProviderIcon provider={icon} size={size} />
);

/**
 * The model picker shared by every prompt style: the SDK's model slot edited
 * through its catalogs (providers, presets, free-form entries), with provider
 * icons supplied for the catalog groups.
 *
 * Until the definition has loaded, the current value is shown as text.
 *
 * An edit shows at once and is sent once it settles, so typing or pasting a
 * model ID isn't a save per keystroke. Only until then is it held here: once
 * sent, `value` shows it — which, unlike a copy kept here, follows the model
 * changing elsewhere even when the server reads a picked preset back in a
 * different shape (one binding rather than the preset's candidates).
 */
export default function ModelRow({
  definition,
  value,
  editable,
  onChange,
}: {
  /** The SDK's model slot, or `null` while it loads. */
  definition: PropDefinition | null;
  value: PropValue | undefined;
  editable: boolean;
  onChange: (value: PropValue) => void;
}) {
  const [unsent, setUnsent] = useState<PropValue>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleChange = (next: PropValue) => {
    setUnsent(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Batched with the edit's optimistic update, so nothing flickers back.
      onChange(next);
      setUnsent(undefined);
    }, EDIT_SAVE_DELAY_MS);
  };
  const shown = unsent ?? value;

  if (!definition) {
    return (
      <div className="pg-catalog pg-model-row-pending">
        <span className={`proppy-catalog-label${shown ? "" : " placeholder"}`}>
          {shown ? valueToDisplayString(shown) : "Select a model…"}
        </span>
      </div>
    );
  }
  return (
    <CatalogIconContext.Provider value={renderIcon}>
      <div className="pg-model-row">
        <ItemEditor
          propDef={definition}
          value={shown}
          onChange={handleChange}
          className="pg-catalog"
          disabled={!editable}
        />
      </div>
    </CatalogIconContext.Provider>
  );
}
