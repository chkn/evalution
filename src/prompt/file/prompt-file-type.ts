// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type {
  ProbeResult,
  ProbeResults,
  TypeProbe,
} from "@evalution/sdk/adapter";
import type { PropDefinition, ValueFactory } from "ts-proppy";
import type { FileProvider } from "../../file-provider.ts";
import type {
  NormalizedPrompt,
  ParsedPrompt,
  PropValue,
} from "../../shared/types.ts";
import type { TSPromptFileType } from "./ts/ts-prompt-file-type.ts";

export type {
  FactoriesProbe,
  ProbeResult,
  ProbeResults,
  TypeExpressionProbe,
  TypeProbe,
} from "@evalution/sdk/adapter";

/** Metadata attached to prompts that originate from a file on disk. */
export interface FilePromptMetadata {
  /** Path to the source file relative to the {@link FilePromptProviderOptions.rootDir}. */
  relativeFilePath: string;
}

/**
 * A {@link ParsedPrompt} produced by the file-based parser, with
 * {@link FilePromptMetadata} guaranteed to be present on `metadata`.
 *
 * This is the low-level form emitted by {@link PromptFileType.parsePrompts};
 * {@link FilePromptProvider} converts it to a {@link NormalizedFilePrompt}
 * before exposing it publicly.
 */
export interface ParsedFilePrompt extends ParsedPrompt {
  metadata: FilePromptMetadata;
}

/**
 * A {@link NormalizedPrompt} whose `metadata` field is guaranteed to carry
 * {@link FilePromptMetadata}. This is the public-facing prompt type returned
 * by {@link FilePromptProvider}.
 */
export type NormalizedFilePrompt = NormalizedPrompt & {
  metadata: FilePromptMetadata;
};

/** Options accepted by {@link PromptFileType.parsePrompts}. */
export interface ParsePromptsOptions {
  /**
   * Files that are not prompts but that should be understood alongside them —
   * playground modules, chiefly.
   *
   * A file type that resolves types is expected to bring these into the same
   * type-resolution scope as the prompts, so both sides of a
   * resource-to-parameter match can be named by one checker. One that doesn't
   * resolve types may ignore them.
   */
  companionFiles?: readonly string[];
}

/** The project-scoped half of a {@link TypeResolutionRequest}. */
export interface ProjectProbeRequest {
  /**
   * The project root. Probes are evaluated in a virtual module there, so they
   * see the project's own module resolution — the *installed* SDK versions.
   */
  rootDir: string;
  /** The probes to evaluate. */
  probes: readonly TypeProbe[];
}

/** A {@link TypeProbe} together with the prompt it is being asked about. */
export interface TypeProbeRequest {
  /** The probe to evaluate. */
  probe: TypeProbe;
  /** Absolute path of the prompt's source file. */
  filePath: string;
  /** Name of the prompt within that file. */
  promptName: string;
}

/** A candidate input source, named by the type it supplies. */
export interface SlotMatchSource {
  /** Echoed back in the result to identify this source. */
  key: string;
  /**
   * Type expression, in the file type's {@link PromptFileType.language},
   * naming the type this source supplies.
   *
   * Expression rather than a type *name* so the caller need not teach the file
   * type what a resource (or a dataset column, later) is: whatever knows how
   * to describe its own type writes it down, and the file type only evaluates.
   */
  expression: string;
}

/** One prompt's worth of source-to-slot matching. See {@link PromptFileType.resolveSlotMatches}. */
export interface SlotMatchRequest {
  /** Absolute path of the prompt's source file. */
  filePath: string;
  /** Name of the prompt within that file. */
  promptName: string;
  /** The candidates to test. */
  sources: readonly SlotMatchSource[];
  /**
   * Root slots beyond the prompt function's own parameters, as slot name →
   * type expression (the same `$config` substitution as a {@link TypeProbe}).
   * Used for execute parameters, whose types are not in the signature.
   */
  extraSlots?: Record<string, string>;
}

/**
 * Every type question one normalization pass asks, put to
 * {@link PromptFileType.resolveTypes} together so they can share one checker.
 */
export interface TypeResolutionRequest {
  /** Probes to evaluate. See {@link PromptFileType.resolveTypeProbes}. */
  probes?: readonly TypeProbeRequest[];
  /**
   * Probes about the project rather than any one prompt, evaluated once. A
   * file type may cache their results for as long as the modules they
   * reference are unchanged.
   */
  project?: ProjectProbeRequest;
  /** Slot matches to decide. See {@link PromptFileType.resolveSlotMatches}. */
  slotMatches?: readonly SlotMatchRequest[];
}

/** Answers to a {@link TypeResolutionRequest}, positional within each list. */
export interface TypeResolutionResult {
  /** One per probe request, with the same meaning as {@link PromptFileType.resolveTypeProbes}. */
  probes: ProbeResult[];
  /**
   * The project probes' results, by probe name. Every requested probe has an
   * entry, `undefined` when it could not be evaluated.
   */
  project?: ProbeResults;
  /** One per slot match request, with the same meaning as {@link PromptFileType.resolveSlotMatches}. */
  slotMatches: Record<string, string[]>[];
}

/**
 * Strategy object that knows how to parse, edit, and execute a specific
 * prompt file format.
 *
 * The default implementation is {@link TSPromptFileType}, which handles
 * TypeScript `.prompt.ts` files. Provide a custom implementation to support
 * other file formats, then pass it to {@link FilePromptProvider} via its
 * `fileType` option.
 */
export interface PromptFileType {
  /**
   * The language prompt files are written in (e.g. `'typescript'`).
   *
   * Advertises the dialect, not a guarantee: an {@link SDKAdapter} is asked
   * for probes *in* this language and decides for itself whether it can speak
   * it, but a file type parsed without a checker still says `typescript` and
   * still resolves nothing. The client also uses it to syntax-highlight prompt
   * source, which it otherwise has to infer.
   */
  language: string;

  /**
   * Glob patterns used by {@link FilePromptProvider} when no explicit
   * `includePatterns` option is provided.
   */
  defaultIncludePatterns: readonly string[];

  /**
   * File extension appended to a new prompt's filename when the user does not
   * supply one (e.g. `'.prompt.ts'`). Includes the leading dot.
   */
  defaultFileExtension: string;

  /**
   * Generates the starter source code for a new prompt file.
   * @param promptsId - The module ID passed to the `prompts()` helper (typically derived from the file name).
   * @param name - The initial prompt function name.
   * @param importPath - The package path to import the `prompts()` helper from.
   */
  newPromptSkeleton(
    promptsId: string,
    name: string,
    importPath: string,
  ): string;

  /**
   * Parses the given files and returns all discovered prompts.
   * Reads fresh file content at the time of the call.
   * @param files - Absolute paths of the files to parse.
   * @param rootDir - The project root; used to compute relative prompt IDs.
   * @param options - See {@link ParsePromptsOptions}.
   */
  parsePrompts(
    files: string[],
    rootDir: string,
    options?: ParsePromptsOptions,
  ): Promise<ParsedFilePrompt[]>;

  /**
   * Updates the value of an existing property in a prompt source file.
   * @param filePath - Absolute path to the file to edit.
   * @param propDef - The property definition to update (must carry source-position metadata).
   * @param value - The new value to write.
   * @param promptId - The prompt ID, used to re-parse for fresh spans.
   */
  updateProperty(
    filePath: string,
    propDef: PropDefinition,
    value: PropValue,
    promptId?: string,
  ): Promise<void>;

  /**
   * Removes a property from a prompt source file entirely.
   * @param filePath - Absolute path to the file to edit.
   * @param propDef - The property definition to remove.
   */
  removeProperty(filePath: string, propDef: PropDefinition): Promise<void>;

  /**
   * Adds a new property to a prompt in a source file.
   * @param filePath - Absolute path to the file to edit.
   * @param promptName - Name of the exported function to add the property to.
   * @param propertyName - The key to add.
   * @param value - The value to assign.
   */
  addProperty(
    filePath: string,
    promptName: string,
    propertyName: string,
    value: PropValue,
  ): Promise<void>;

  /**
   * Renames an exported prompt in a source file.
   * @param filePath - Absolute path to the file to edit.
   * @param oldName - Current prompt name.
   * @param newName - New prompt name.
   */
  renamePrompt(
    filePath: string,
    oldName: string,
    newName: string,
  ): Promise<void>;

  /**
   * Dynamically imports `filePath`, calls the exported function named
   * `promptName` with `params`, and returns the resulting config object.
   *
   * @param filePath - Absolute path to the prompt file.
   * @param promptName - Name of the exported function to invoke.
   * @param params - Positional arguments forwarded to the function.
   */
  loadConfig(filePath: string, promptName: string, params: any[]): Promise<any>;

  /**
   * Evaluates `requests` and reports what each probe resolved to.
   *
   * The result is positional — one entry per request, in order — and
   * three-valued, because "there is no such requirement" and "I could not tell
   * you" are different answers and callers must treat them differently:
   *
   * - a {@link PropDefinition} (a `type` probe) or a list of
   *   {@link ValueFactory}s (a `factories` probe) — resolved;
   * - `null` — resolved, and this prompt has no such requirement (the
   *   expression evaluated to `never`);
   * - `undefined` — could not be evaluated.
   *
   * Optional. A file type with no way to evaluate types omits it entirely, and
   * callers should then degrade to a declared-but-unresolved parameter rather
   * than to silence.
   *
   * Probes arrive **batched across every prompt** so they can all ride in a
   * single program build; resolving them one prompt at a time would throw that
   * away.
   *
   * @param requests - The expressions to evaluate, each paired with the
   *   prompt it concerns. See {@link TypeProbeRequest}.
   */
  resolveTypeProbes?(
    requests: readonly TypeProbeRequest[],
  ): Promise<ProbeResult[]>;

  /**
   * Decides, for each request, which of its sources can supply which of the
   * prompt's input slots — the type-based half of source matching.
   *
   * A slot is a parameter or any object property nested inside one, addressed
   * by a dotted path (`taskId`, `ctx.db`, `toolsContext.list_tasks.db`). Fit is
   * **assignability**, not name or spelling equality: `TaskId` and
   * `` `tsk_${string}` `` are one type written two ways, and a source that
   * produces either must be offered on a slot declared as the other.
   *
   * A match never implies a slot has no editor of its own — that is decided
   * from the slot's type alone. A `TaskId` slot keeps its text field and gains
   * the source beside it.
   *
   * Optional. Without it, callers fall back to matching on names, which is
   * what happens whenever no checker is available anyway.
   *
   * @param requests - One entry per prompt. See {@link SlotMatchRequest}.
   * @returns Positional, one per request: slot path → the `key`s of the
   *   sources that fit it.
   */
  resolveSlotMatches?(
    requests: readonly SlotMatchRequest[],
  ): Promise<Record<string, string[]>[]>;

  /**
   * Answers probes and slot matches together: the same questions, with the
   * same answers, as {@link resolveTypeProbes} and {@link resolveSlotMatches},
   * but sharing whatever it costs to answer them. For a checker-backed file
   * type that is a whole program build, so a caller with both kinds of
   * question should prefer this.
   *
   * Optional. When omitted, callers ask the two separately.
   *
   * @param requests - See {@link TypeResolutionRequest}.
   */
  resolveTypes?(requests: TypeResolutionRequest): Promise<TypeResolutionResult>;

  /**
   * A file type like this one that does all its file I/O — reading, writing
   * and importing prompt files — through `fileProvider` instead.
   *
   * How a prompt variation is materialized: the provider hands the copy an
   * {@link OverlayFileProvider} holding the variation's source at the
   * prompt's real path, and parses, edits and runs it through that.
   *
   * Optional. A file type without it can't show or run variations.
   */
  withFileProvider?(fileProvider: FileProvider): PromptFileType;
}
