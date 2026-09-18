// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import {
  CatalogIconContext,
  ItemEditor,
  valueToDisplayString,
} from "ts-proppy/react";
import type { PropDefinition, PropValue } from "../../shared/types";
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
  if (!definition) {
    return (
      <div className="pg-catalog pg-model-row-pending">
        <span className={`proppy-catalog-label${value ? "" : " placeholder"}`}>
          {value ? valueToDisplayString(value) : "Select a model…"}
        </span>
      </div>
    );
  }
  return (
    <CatalogIconContext.Provider value={renderIcon}>
      <div className="pg-model-row">
        <ItemEditor
          propDef={definition}
          value={value}
          onChange={onChange}
          className="pg-catalog"
          disabled={!editable}
        />
      </div>
    </CatalogIconContext.Provider>
  );
}
