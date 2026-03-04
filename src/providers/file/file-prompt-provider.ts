import path from 'path';
import type { PromptProvider, PromptChangeEvent } from '../prompt-provider.ts';
import { TSPromptFileType, type PromptFileType, type PromptFileParser } from './prompt-file-type.ts';
import { LocalFileProvider, type FileProvider } from './file-provider.ts';
import { VercelAISDK, type SDKAdapter } from '../../server/sdk-adapter.ts';
import type { ParsedPrompt } from '../../shared/types.ts';

const DEFAULT_IGNORE_PATTERNS = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

/**
 * Configuration options for the {@link FilePromptProvider}.
 */
export interface FilePromptProviderOptions {
  /**
   * Uniquely identifies this provider instance when multiple providers are used together. Defaults to 'fs' + an incrementing number.
   */
  id?: string;

  /**
   * The root directory to scan recursively for prompt files. Defaults to the current working directory.
   */
  rootDir?: string;
  /**
   * Glob patterns to include when scanning for prompt files. Defaults to {@link PromptFileType.defaultIncludePatterns}.
   */
  includePatterns?: readonly string[];
  /**
   * Glob patterns to exclude when scanning for prompt files. Defaults to ['\*\*\/node_modules/\*\*', '\*\*\/dist/\*\*', '\*\*\/.git/**'].
   */
  ignorePatterns?: readonly string[];

  /**
   * Optional custom file provider that abstracts file system access, useful for testing or non-local environments. Defaults to an instance of {@link LocalFileProvider}.
   */
  fileProvider?: FileProvider;

  /**
   * Optional custom file type handler that defines how to parse prompt files and manipulate properties. Defaults to an instance of {@link TSPromptFileType}.
   */
  fileType?: PromptFileType;

  /**
   * SDK adapter that governs prompt structure and execution. Defaults to an instance of {@link VercelAISDK}, which supports Vercel AI SDK conventions.
   */
  sdk?: SDKAdapter;
}

let defaultIDCounter = 0;

/**
 * A {@link PromptProvider} that discovers and serves prompts from
 * files on the local file system (or any {@link FileProvider}).
 *
 * Out of the box it scans for `**\/*.prompt.ts` files, parses them with
 * {@link TSPromptFileType}, and executes them via {@link VercelAISDK}. All
 * three defaults are replaceable through {@link FilePromptProviderOptions}.
 *
 * @example
 * ```ts
 * const provider = new FilePromptProvider({ rootDir: '/my/project' });
 * const prompts = await provider.getAllPrompts();
 * ```
 */
export class FilePromptProvider implements PromptProvider {
  readonly id: string;
  private parser: PromptFileParser | null = null;
  private rootDir: string;
  private fileType: PromptFileType;
  private fileProvider: FileProvider;
  private includePatterns: readonly string[];
  private ignorePatterns: readonly string[];
  private sdkAdapter: SDKAdapter;

  constructor({
    id = 'fs' + (defaultIDCounter++ ? defaultIDCounter : ''),
    rootDir = process.cwd(),
    fileProvider = new LocalFileProvider(),
    fileType,
    includePatterns,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    sdk = new VercelAISDK(),
  }: FilePromptProviderOptions = {}) {
    fileType ??= new TSPromptFileType(fileProvider);
    this.id = id;
    this.rootDir = rootDir;
    this.fileProvider = fileProvider;
    this.fileType = fileType;
    this.includePatterns = includePatterns ?? fileType.defaultIncludePatterns;
    this.ignorePatterns = ignorePatterns;
    this.sdkAdapter = sdk;
  }

  async getAllPrompts(): Promise<ParsedPrompt[]> {
    await this.ensureParser();
    return this.parser!.parseAll();
  }

  async getPrompt(id: string): Promise<ParsedPrompt | null> {
    const [filePath, name] = this.parsePromptId(id);
    await this.ensureParser();

    const prompts = this.parser!.parseFile(filePath);
    return prompts.find(p => p.name === name) || null;
  }

  async updatePromptProperties(
    promptId: string,
    updates: Record<string, any>
  ): Promise<ParsedPrompt> {
    const prompt = await this.getPrompt(promptId);
    if (!prompt) {
      throw new Error('Prompt not found');
    }

    const [filePath, promptName] = this.parsePromptId(promptId);

    for (const [propertyName, value] of Object.entries(updates)) {
      const prop = prompt.properties[propertyName];

      if (value === null) {
        // null → remove the property
        if (!prop) throw new Error(`Property '${propertyName}' not found`);
        await this.fileType.removeProperty(filePath, prop);
      } else if (!prop) {
        // unknown key → add as a new property
        await this.fileType.addProperty(filePath, promptName, propertyName, value);
      } else {
        // existing key → update in place
        if (!prop.isEditable) {
          throw new Error(`Property '${propertyName}' is not editable`);
        }
        if (!prop.valueSpan) {
          throw new Error(`Property '${propertyName}' is missing source metadata`);
        }
        await this.fileType.updateProperty(filePath, prop, value);
      }
    }

    // Re-scan and re-parse to get updated prompt
    await this.refresh();
    return (await this.getPrompt(promptId))!;
  }

  getModelParameters() {
    return this.sdkAdapter.getModelParameters(this.rootDir);
  }

  async execute(promptId: string, params: any[], stream: boolean): Promise<any> {
    const [filePath, promptName] = this.parsePromptId(promptId);
    const config = await this.fileType.loadConfig(filePath, promptName, params);
    return this.sdkAdapter.executeConfig(config, stream);
  }

  watch(callback: (event: PromptChangeEvent) => void): () => void {
    return this.fileProvider.watch(
      this.includePatterns,
      { cwd: this.rootDir, ignored: this.ignorePatterns },
      async (eventType, filePath) => {
        if (eventType === 'change' || eventType === 'add') {
          const absolutePath = this.resolveFilePath(filePath);
          await this.refresh();
          const prompts = this.parser!.parseFile(absolutePath);
          prompts.forEach(prompt => {
            callback({ type: eventType === 'change' ? 'change' : 'add', promptId: prompt.id });
          });
        } else {
          // filePath is relative to rootDir (chokidar cwd)
          callback({ type: 'remove', promptId: filePath });
        }
      }
    );
  }

  private async ensureParser(): Promise<void> {
    if (!this.parser) {
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    const files = await Array.fromAsync(this.findPromptFiles());
    this.parser = await this.fileType.createParser(files, this.rootDir);
  }

  private async* findPromptFiles(): AsyncIterableIterator<string> {
    const uniqueFiles = new Set<string>();

    for (const pattern of this.includePatterns) {
      const iter = this.fileProvider.glob(pattern, {
        cwd: this.rootDir,
        absolute: true,
        ignore: this.ignorePatterns,
      });
      for await (const file of iter) {
        if (!uniqueFiles.has(file)) {
          uniqueFiles.add(file);
          yield file;
        }
      }
    }
  }

  private parsePromptId(id: string): [string, string] {
    const hashIdx = id.lastIndexOf('#');
    if (hashIdx < 0) {
      throw new Error(`Invalid prompt ID format: ${id}`);
    }
    const relativePath = id.slice(0, hashIdx);
    const functionName = id.slice(hashIdx + 1);
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(this.rootDir, relativePath);
    return [absolutePath, functionName];
  }

  private resolveFilePath(relativePath: string): string {
    if (relativePath.startsWith('/')) {
      return relativePath;
    }
    return `${this.rootDir}/${relativePath}`;
  }
}
