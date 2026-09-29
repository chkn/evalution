// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * How long a typed edit settles before the editor sends it. Short, because
 * an edit lands in the prompt's unsaved edits rather than its file; long
 * enough that typing isn't a request per keystroke.
 */
export const EDIT_SAVE_DELAY_MS = 250;
