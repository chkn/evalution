import type { PromptProperty } from '../../shared/types.ts';
import type { PromptFileParser } from '../../parser/prompt-parser.ts';
import type { TSPromptFileType } from './ts/TSPromptFileType.ts';

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
   * Creates a {@link PromptFileParser} for the given set of files.
   * @param files - Absolute paths of the files to include.
   * @param rootDir - The project root; used to compute relative prompt IDs.
   */
  createParser(files: string[], rootDir: string): Promise<PromptFileParser>;

  /**
   * Updates the value of an existing property in a prompt source file.
   * @param filePath - Absolute path to the file to edit.
   * @param prop - The property to update (must carry source-position metadata).
   * @param value - The new value to write.
   */
  updateProperty(filePath: string, prop: PromptProperty, value: any): Promise<void>;

  /**
   * Removes a property from a prompt source file entirely.
   * @param filePath - Absolute path to the file to edit.
   * @param prop - The property to remove.
   */
  removeProperty(filePath: string, prop: PromptProperty): Promise<void>;

  /**
   * Adds a new property to a prompt in a source file.
   * @param filePath - Absolute path to the file to edit.
   * @param promptName - Name of the exported function to add the property to.
   * @param propertyName - The key to add.
   * @param value - The value to assign.
   */
  addProperty(filePath: string, promptName: string, propertyName: string, value: any): Promise<void>;

  /**
   * Renames an exported prompt in a source file.
   * @param filePath - Absolute path to the file to edit.
   * @param oldName - Current prompt name.
   * @param newName - New prompt name.
   */
  renamePrompt(filePath: string, oldName: string, newName: string): Promise<void>;

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


