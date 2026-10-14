// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { shortSyntax } from "ts-proppy/react";
import {
  type ColumnPath,
  fieldPath,
  instancePath,
} from "../../shared/column-paths";
import { PRIMITIVE_FIELD_TYPES } from "../../shared/dataset-fields";
import type {
  DatasetField,
  DatasetPathChild,
  DatasetRowsOverview,
  NormalizedPrompt,
  PromptID,
} from "../../shared/types";
import { addDatasetField } from "../api";
import {
  addFieldRequest,
  choiceFor,
  defaultFieldName,
  parameterOptionGroups,
  resourceInputGroups,
} from "./dataset-field-options";
import { previewCell } from "./dataset-preview";
import { useAnchoredPopover } from "./use-anchored-popover";

/** What "New field" needs to add a field to a dataset. */
export interface NewFieldConfig {
  providerId: string;
  datasetId: string;
  /**
   * Every loaded prompt, whose parameters — and whose resources' inputs — a
   * field can copy the type of.
   */
  prompts: readonly NormalizedPrompt[];
  /** The dataset's (resolved) linked prompt, whose parameters come first. */
  linked?: PromptID;
}

interface AddColumnMenuProps {
  fields: readonly DatasetField[];
  /** The rows' resource instances, offered as roots. */
  instances: DatasetRowsOverview["instances"];
  /** The keys one level inside a path. */
  describePath: (path: ColumnPath) => Promise<DatasetPathChild[]>;
  /** A node of the tree was chosen: add a column at its path. */
  onPick: (path: ColumnPath) => void;
  newField: NewFieldConfig;
  /** A field has been added through "New field". */
  onFieldAdded: () => void;
  /** Shows a "‹ Columns" button that returns to the menu this one replaced. */
  onBack?: () => void;
}

interface DatasetAddColumnProps extends Omit<AddColumnMenuProps, "onBack"> {
  /** How far down the grid's header row starts — below any group headers. */
  top: number;
  /** The header row's height, which the trigger fills. */
  height: number;
}

/**
 * The "＋" at the right end of a dataset grid's header row, and the
 * {@link AddColumnMenu} it opens — the same one as the Columns dropdown's
 * "Add column…". Rendered as Glide's `rightElement`, right after the last
 * column, so it scrolls with the grid. See `specs/datasets.md` §P.1.
 */
export function DatasetAddColumn({
  top,
  height,
  onPick,
  onFieldAdded,
  ...menu
}: DatasetAddColumnProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  const popover =
    open &&
    createPortal(
      <div
        className="trace-column-picker dataset-column-picker"
        ref={popoverRef}
        style={style}
        role="dialog"
        aria-label="Add column"
      >
        <AddColumnMenu
          {...menu}
          onPick={path => {
            onPick(path);
            close();
          }}
          onFieldAdded={() => {
            onFieldAdded();
            close();
          }}
        />
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
        title="Add column"
        aria-label="Add column"
        aria-expanded={open}
      >
        ＋
      </button>
      {popover}
    </div>
  );
}

/**
 * What the dataset view offers for adding a column, both from the Columns
 * dropdown's "Add column…" and from the grid's "＋": "New field", which opens
 * a form to add a field to the dataset (P.1), below the rows' paths as a tree
 * (Q.2). See `specs/datasets.md`.
 */
export function AddColumnMenu({
  fields,
  instances,
  describePath,
  onPick,
  newField,
  onFieldAdded,
  onBack,
}: AddColumnMenuProps) {
  const [creating, setCreating] = useState(false);

  if (creating) {
    return (
      <div className="dataset-path-tree" role="group" aria-label="New field">
        <button
          type="button"
          className="trace-header-menu-item dataset-path-tree-back"
          onClick={() => setCreating(false)}
        >
          <span className="trace-header-menu-item-label">‹ Add column</span>
        </button>
        <NewFieldForm {...newField} onAdded={onFieldAdded} />
      </div>
    );
  }

  return (
    <div className="dataset-path-tree" role="group" aria-label="Add column">
      {onBack && (
        <button
          type="button"
          className="trace-header-menu-item dataset-path-tree-back"
          onClick={onBack}
        >
          <span className="trace-header-menu-item-label">‹ Columns</span>
        </button>
      )}
      {fields.map(f => (
        <PathNode
          key={f.id}
          path={fieldPath(f.id)}
          label={f.def.name}
          depth={0}
          describePath={describePath}
          onPick={onPick}
        />
      ))}
      {Object.entries(instances).map(([name, shape]) => (
        <PathNode
          key={`@${name}`}
          path={instancePath(name)}
          label={`◆ ${name}`}
          detail={shape.uri.slice(shape.uri.lastIndexOf("#") + 1)}
          depth={0}
          describePath={describePath}
          onPick={onPick}
        />
      ))}
      <button
        type="button"
        className="trace-header-menu-item dataset-path-tree-new"
        onClick={() => setCreating(true)}
      >
        <span className="trace-header-menu-item-label">New field…</span>
      </button>
    </div>
  );
}

/**
 * "New field": a name box and a type picker — `string`, `number`, `boolean`,
 * or the type of a prompt parameter or a resource input, which the server
 * looks up and copies. A rejected add (a duplicate, say) is shown in the
 * form. See `specs/datasets.md` §P.1.
 */
function NewFieldForm({
  providerId,
  datasetId,
  prompts,
  linked,
  onAdded,
}: NewFieldConfig & { onAdded: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("string");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(
    () => parameterOptionGroups(prompts, linked),
    [prompts, linked],
  );
  const resources = useMemo(() => resourceInputGroups(prompts), [prompts]);
  const choice = choiceFor(type, groups, resources) ?? {
    kind: "primitive",
    type: "string",
  };
  const request = addFieldRequest(name, choice);

  const submit = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      await addDatasetField(providerId, datasetId, request);
      onAdded();
    } catch (err: any) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  };

  return (
    <div className="dataset-add-field">
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
            data-1p-ignore
            className="add-to-dataset-name"
            aria-label="Field name"
            value={name}
            placeholder={defaultFieldName(choice) || undefined}
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
                key={group.key}
                label={`Same type as a parameter of ${group.label}${group.linked ? " (linked)" : ""}`}
              >
                {group.options.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.def.name}: {shortSyntax(option.def.type.syntax, 40)}
                  </option>
                ))}
              </optgroup>
            ))}
            {resources.map(group => (
              <optgroup
                key={group.key}
                label={`Same type as an input of resource ${group.label}`}
              >
                {group.options.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.def.name}: {shortSyntax(option.def.type.syntax, 40)}
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
    </div>
  );
}

/** One node of the path tree, fetching its children when first expanded. */
function PathNode({
  path,
  label,
  detail,
  depth,
  describePath,
  onPick,
}: {
  path: ColumnPath;
  label: string;
  detail?: string;
  depth: number;
  describePath: (path: ColumnPath) => Promise<DatasetPathChild[]>;
  onPick: (path: ColumnPath) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DatasetPathChild[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      describePath(path).then(setChildren, (err: Error) =>
        setError(err.message),
      );
    }
  };

  return (
    <div>
      <div
        className="dataset-path-tree-node"
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          type="button"
          className="dataset-column-picker-disclosure"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={toggle}
          disabled={children?.length === 0}
        >
          {children?.length === 0 ? "" : expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className="dataset-path-tree-pick"
          title={`Add a column at ${label}`}
          onClick={() => onPick(path)}
        >
          <span className="dataset-column-picker-title">{label}</span>
          {detail && (
            <span className="dataset-column-picker-detail">{detail}</span>
          )}
        </button>
      </div>
      {expanded && (
        <div role="group">
          {error && <div className="dataset-path-tree-note">{error}</div>}
          {children === null && !error && (
            <div
              className="dataset-path-tree-note"
              style={{ paddingLeft: 22 + (depth + 1) * 14 }}
            >
              Loading…
            </div>
          )}
          {children?.map(child => (
            <PathNode
              key={child.key}
              path={{ root: path.root, keys: [...path.keys, child.key] }}
              label={child.key}
              {...(child.sample && { detail: previewCell(child.sample) })}
              depth={depth + 1}
              describePath={describePath}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
