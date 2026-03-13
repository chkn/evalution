import type { ModelCatalog, PromptProperty } from '../../shared/types.ts';
import { PromptParser, type ParsedFilePrompt } from '../../parser/prompt-parser.ts';
import { PromptEditor } from '../../parser/prompt-editor.ts';
import { LocalFileProvider, type FileProvider } from './file-provider.ts';

/**
 * Read-only view of a parsed prompt tree, obtained via
 * {@link PromptFileType.createParser}.
 */
export interface PromptFileParser {
  /** Parses every file known to this parser and returns all discovered prompts. */
  parseAll(): ParsedFilePrompt[];

  /**
   * Parses a single file and returns the prompts it defines.
   * @param filePath - Absolute path to the file to parse.
   */
  parseFile(filePath: string): ParsedFilePrompt[];
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

/**
 * {@link PromptFileType} implementation for TypeScript `.prompt.ts` files.
 *
 * Each prompt is an exported function that returns an SDK-specific config
 * object. For example, for the Vercel AI SDK, a prompt file might look like this:
 *
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 *
 * export function myPrompt() {
 *   return {
 *     model: openai('gpt-4o'),
 *     system: 'You are a helpful assistant.',
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *   };
 * }
 * ```
 *
 * @example
 * ```ts
 * const fileType = new TSPromptFileType();
 * const parser = await fileType.createParser(['/path/to/my.prompt.ts'], '/path/to');
 * const prompts = parser.parseAll();
 * ```
 */
export class TSPromptFileType implements PromptFileType {
  defaultIncludePatterns = ['**/*.prompt.ts', '**/*.promp.ts'];

  private editor: PromptEditor;
  private fileProvider: FileProvider;

  constructor(fileProvider: FileProvider = new LocalFileProvider(), getModelCatalog: () => Promise<ModelCatalog>) {
    this.fileProvider = fileProvider;
    this.editor = new PromptEditor(fileProvider, getModelCatalog);
  }

  createParser(files: string[], rootDir: string): Promise<PromptFileParser> {
    return PromptParser.create(files.map(file => [file, this.fileProvider.readFile(file)] as const), rootDir);
  }

  updateProperty(filePath: string, prop: PromptProperty, value: any): Promise<void> {
    return this.editor.updateProperty(filePath, prop, value);
  }

  removeProperty(filePath: string, prop: PromptProperty): Promise<void> {
    return this.editor.removeProperty(filePath, prop);
  }

  addProperty(filePath: string, promptName: string, propertyName: string, value: any): Promise<void> {
    return this.editor.addProperty(filePath, promptName, propertyName, value);
  }

  renamePrompt(filePath: string, oldName: string, newName: string): Promise<void> {
    return this.editor.renameFunction(filePath, oldName, newName);
  }

  async loadConfig(filePath: string, promptName: string, params: any[]): Promise<any> {
    const module = await this.fileProvider.import(filePath);
    const fn = module[promptName];

    if (typeof fn !== 'function') {
      throw new Error(`Function '${promptName}' not found in ${filePath}`);
    }

    const config = fn(...params);

    if (!config || typeof config !== 'object') {
      throw new Error(`'${promptName}' did not return a valid config object`);
    }

    return config;
  }
}
