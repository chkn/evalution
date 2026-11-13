// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Says a database is being brought into the project's sync: its file is
 * swapped for a copy of the cloud's that holds its rows too. Changes to it
 * wait in memory meanwhile, so they're lost if evalution stops before then.
 */
export function SyncingIndicator({ label = true }: { label?: boolean }) {
  return (
    <span
      className="syncing-indicator"
      role="status"
      aria-label={label ? undefined : "Syncing"}
      title="Starting to sync with Evalution Cloud. Changes made now are saved once it's done — keep evalution running until then."
    >
      <span className="syncing-indicator-ring" aria-hidden="true" />
      {label && "Syncing"}
    </span>
  );
}
