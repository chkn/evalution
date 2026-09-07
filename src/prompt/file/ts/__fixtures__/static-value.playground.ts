// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { resource } from "../../../playground/resource.ts";

/**
 * A static resource: its type is read off `value` directly, since there is
 * no `create()` to read it from.
 *
 * Named and spelled differently from the slot it fills (`workspaceId:
 * WorkspaceId` in `static-value.prompt.ts`) on purpose: matching only by
 * name, or only by identical type text, would hide whether the checker is
 * actually reading `value`'s type back off this declaration.
 */
export const defaultWorkspace = resource({
  label: "Default workspace",
  value: "ws_internal_default" as `ws_${string}`,
});
