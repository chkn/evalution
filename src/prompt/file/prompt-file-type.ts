// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { PropDefinition } from "ts-proppy";
import type {
  ModelPropValue,
  NormalizedPrompt,
  ParsedPrompt,
} from "../../shared/types.ts";
import type { TSPromptFileType } from "./ts/ts-prompt-file-type.ts";

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
export interface NormalizedFilePrompt extends NormalizedPrompt {
  metadata: FilePromptMetadata;
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
   */
  parsePrompts(files: string[], rootDir: string): Promise<ParsedFilePrompt[]>;

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
    value: ModelPropValue,
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
    value: ModelPropValue,
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
}
