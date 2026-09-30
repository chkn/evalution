// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { shortSyntax } from "ts-proppy/react";
import type { NormalizedPrompt, PromptID } from "../../shared/types";
import { addDatasetField } from "../api";
import {
  addFieldRequest,
  choiceFor,
  defaultFieldName,
  PRIMITIVE_FIELD_TYPES,
  parameterOptionGroups,
} from "./dataset-field-options";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  providerId: string;
  datasetId: string;
  /** Every loaded prompt, whose parameters a field can copy the type of. */
  prompts: readonly NormalizedPrompt[];
  /** The dataset's (resolved) linked prompt, whose parameters come first. */
  linked?: PromptID;
  /** How far down the grid's header row starts — below any group headers. */
  top: number;
  /** The header row's height, which the trigger fills. */
  height: number;
  /** Called once a field has been added. */
  onAdded: () => void;
}

/**
 * The "＋" at the right end of a dataset grid's header row, and the popover
 * it opens: a name box and a type picker — `string`, `number`, `boolean`, or
 * the type of a prompt parameter, which the server looks up and copies. A
 * rejected add (a duplicate, say) is shown in the popover. Rendered as
 * Glide's `rightElement`, so it stays put while the columns scroll. See
 * `specs/datasets.md` §P.1.
 */
export function DatasetAddField({
  providerId,
  datasetId,
  prompts,
  linked,
  top,
  height,
  onAdded,
}: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("string");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  const groups = useMemo(
    () => parameterOptionGroups(prompts, linked),
    [prompts, linked],
  );
  const choice = choiceFor(type, groups) ?? {
    kind: "primitive",
    type: "string",
  };
  const request = addFieldRequest(name, choice);

  const submit = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      await addDatasetField(providerId, datasetId, request);
      setName("");
      setError(null);
      setOpen(false);
      onAdded();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const popover =
    open &&
    createPortal(
      <div
        className="dataset-add-field"
        ref={popoverRef}
        style={style}
        role="dialog"
        aria-label="Add field"
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="dataset-add-field-row">
            <span>Name</span>
            <input
              autoFocus
              className="add-to-dataset-name"
              aria-label="Field name"
              value={name}
              placeholder={defaultFieldName(choice) || "expectedTitle"}
              onChange={e => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="dataset-add-field-row">
            <span>Type</span>
            <select
              className="add-to-dataset-name"
              aria-label="Field type"
              value={type}
              onChange={e => {
                setType(e.target.value);
                setError(null);
              }}
            >
              {PRIMITIVE_FIELD_TYPES.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              {groups.map(group => (
                <optgroup
                  key={`${group.options[0].providerId}\u0000${group.options[0].promptId}`}
                  label={`Same type as a parameter of ${group.label}${group.linked ? " (linked)" : ""}`}
                >
                  {group.options.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.def.name}:{" "}
                      {shortSyntax(option.def.type.syntax, 40)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {error && (
            <div className="dataset-add-field-error" role="alert">
              {error}
            </div>
          )}
          <div className="dataset-add-field-actions">
            <button
              type="submit"
              className="add-to-dataset-create"
              disabled={!request || busy}
            >
              Add field
            </button>
          </div>
        </form>
      </div>,
      document.body,
    );

  return (
    <div className="dataset-add-field-slot" style={{ paddingTop: top }}>
      <button
        type="button"
        ref={triggerRef}
        className="dataset-add-field-trigger"
        style={{ height }}
        onClick={() => (open ? close() : setOpen(true))}
        title="Add field"
        aria-label="Add field"
        aria-expanded={open}
      >
        ＋
      </button>
      {popover}
    </div>
  );
}
