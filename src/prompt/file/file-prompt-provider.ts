// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from 'path';
import type { PromptProvider } from '../prompt-provider.ts';
import type { PromptFileType } from './prompt-file-type.ts';
import type { SDKAdapter } from '../../sdk/sdk-adapter.ts';
import type {
  AddPromptContext,
  ChangeEventType,
  NormalizedPromptUpdates,
  PromptChangeEvent,
} from '../../shared/types.ts';
import type {
  FilePromptMetadata,
  NormalizedFilePrompt,
  ParsedFilePrompt,
} from './prompt-file-type.ts';
import { isEditable } from '../../shared/helpers.ts';

import { TSPromptFileType } from './ts/ts-prompt-file-type.ts';
import { LocalFileProvider, type FileProvider } from '../../file-provider.ts';

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
   * SDK adapter that governs prompt structure and execution.
   */
  sdk: SDKAdapter;
}

let defaultIDCounter = 0;

/**
 * A {@link PromptProvider} that discovers and serves prompts from
 * files on the local file system (or any {@link FileProvider}).
 *
 * Out of the box it scans for `**\/*.prompt.ts` files and parses them with
 * {@link TSPromptFileType}. Pass a {@link FilePromptProviderOptions} to the
 * constructor to customize this behavior. You must specify at least
 * {@link FilePromptProviderOptions.sdk}.
 *
 * @example
 * ```ts
 * const provider = new FilePromptProvider({ rootDir: '/my/project', sdk: new VercelAISDK() });
 * const prompts = await provider.getAllPrompts();
 * ```
 */
export class FilePromptProvider implements PromptProvider<NormalizedFilePrompt> {
  readonly id: string;
  readonly displayName = 'File System';
  readonly description = 'Create a .prompt.ts file';
  readonly icon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0014.5 4H8L6.5 2.5h-5z"/></svg>';

  private files: string[] | null = null;
  private rootDir: string;
  private fileType: PromptFileType;
  private fileProvider: FileProvider;
  private includePatterns: readonly string[];
  private ignorePatterns: readonly string[];
  private sdkAdapter: SDKAdapter;
  private suppressedWatchEvents = new Map<string, { remaining: number; expiresAt: number }>();

  constructor({
    id = 'fs' + (defaultIDCounter++ ? defaultIDCounter : ''),
    rootDir = process.cwd(),
    fileProvider = new LocalFileProvider(),
    fileType,
    includePatterns,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    sdk,
  }: FilePromptProviderOptions) {
    fileType ??= new TSPromptFileType(fileProvider);
    this.id = id;
    this.rootDir = rootDir;
    this.fileProvider = fileProvider;
    this.fileType = fileType;
    this.includePatterns = includePatterns ?? fileType.defaultIncludePatterns;
    this.ignorePatterns = ignorePatterns;
    this.sdkAdapter = sdk;
  }

  async getAllPrompts(): Promise<NormalizedFilePrompt[]> {
    await this.ensureFiles();
    const parsed = await this.fileType.parsePrompts(this.files!, this.rootDir);
    return parsed.map(p => this.normalizeFilePrompt(p));
  }

  async getPrompt(id: string): Promise<NormalizedFilePrompt | null> {
    const parsed = await this.getParsedPrompt(id);
    return parsed ? this.normalizeFilePrompt(parsed) : null;
  }

  async updatePromptProperties(
    promptId: string,
    updates: NormalizedPromptUpdates
  ): Promise<NormalizedFilePrompt> {
    const parsed = await this.getParsedPrompt(promptId);
    if (!parsed) {
      throw new Error('Prompt not found');
    }

    const [filePath, promptName] = this.parsePromptId(promptId);
    const { definitions, values } = parsed.extractedProps;
    const rawUpdates = this.sdkAdapter.denormalizeUpdates(updates, values);

    for (const [propertyName, value] of Object.entries(rawUpdates)) {
      this.suppressNextWatchEvent(filePath, 'change');
      const propDef = definitions.find(d => d.name === propertyName);
      const currentValue = values?.[propertyName];

      if (value === null) {
        // null → remove the property
        if (!propDef) throw new Error(`Property '${propertyName}' not found`);
        await this.fileType.removeProperty(filePath, propDef);
      } else if (!propDef) {
        // unknown key → add as a new property
        await this.fileType.addProperty(filePath, promptName, propertyName, value);
      } else {
        // existing key → update in place
        if (currentValue && !isEditable(currentValue)) {
          throw new Error(`Property '${propertyName}' is not editable`);
        }
        if (!propDef.valueSpan) {
          throw new Error(`Property '${propertyName}' is missing source metadata`);
        }
        await this.fileType.updateProperty(filePath, propDef, value, promptId);
      }
    }

    // Re-scan and re-parse to get updated prompt
    return (await this.getPrompt(promptId))!;
  }

  private async getParsedPrompt(id: string): Promise<ParsedFilePrompt | null> {
    const [filePath, name] = this.parsePromptId(id);
    let prompts: ParsedFilePrompt[];
    try {
      prompts = await this.fileType.parsePrompts([filePath], this.rootDir);
    } catch {
      return null;
    }
    return prompts.find(p => p.name === name) || null;
  }

  private normalizeFilePrompt(parsed: ParsedFilePrompt): NormalizedFilePrompt {
    const normalized = this.sdkAdapter.normalizePrompt(parsed);
    return { ...normalized, metadata: parsed.metadata };
  }

  getModelCatalog() {
    return this.sdkAdapter.getModelCatalog();
  }

  getModelParameters() {
    return this.sdkAdapter.getModelParameters(this.rootDir);
  }

  async execute(promptId: string, params: any[], stream: boolean): Promise<any> {
    const [filePath, promptName] = this.parsePromptId(promptId);
    const config = await this.fileType.loadConfig(filePath, promptName, params);
    return this.sdkAdapter.executeConfig(config, stream);
  }

  async renamePrompt(promptId: string, newName: string): Promise<NormalizedFilePrompt> {
    const [filePath, oldName] = this.parsePromptId(promptId);
    this.suppressNextWatchEvent(filePath, 'change');
    await this.fileType.renamePrompt(filePath, oldName, newName);

    const relFilePath = path.relative(this.rootDir, filePath);
    const prompt = await this.getPrompt(`${relFilePath}#${newName}`);
    if (!prompt) throw new Error('Failed to find renamed prompt');
    return prompt;
  }

  async addPrompt(partial: Partial<NormalizedFilePrompt>): Promise<NormalizedFilePrompt | AddPromptContext> {
    const relFilePath = (partial.metadata as FilePromptMetadata | undefined)?.relativeFilePath;

    if (relFilePath) {
      const normalizedRelFilePath = path.extname(relFilePath)
        ? relFilePath
        : relFilePath + this.fileType.defaultFileExtension;
      const absPath = path.join(this.rootDir, normalizedRelFilePath);
      const baseName = path.basename(normalizedRelFilePath);
      const firstDot = baseName.indexOf('.');
      const promptsId = firstDot >= 0 ? baseName.slice(0, firstDot) : baseName;
      const name = partial.name ?? promptsId;

      const content = this.fileType.newPromptSkeleton(promptsId, name, this.sdkAdapter.promptsHelperImport);

      this.suppressNextWatchEvent(absPath, 'add');
      await this.fileProvider.writeFile(absPath, content);
      if (this.files && !this.files.includes(absPath)) {
        this.files.push(absPath);
      }

      const prompt = await this.getPrompt(`${normalizedRelFilePath}#${name}`);
      if (!prompt) throw new Error('Failed to create prompt');
      return prompt;
    }

    // Need more info — return form fields
    const directories = await this.listDirectories();
    const prompts = await this.getAllPrompts();
    const dirCounts = new Map<string, number>();
    for (const p of prompts) {
      const dir = path.dirname(p.metadata.relativeFilePath);
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    let defaultDir = '.';
    let maxCount = 0;
    for (const [dir, count] of dirCounts) {
      if (count > maxCount && directories.includes(dir)) {
        defaultDir = dir;
        maxCount = count;
      }
    }

    return {
      fields: [
        {
          name: 'directory',
          label: 'Directory',
          type: 'select' as const,
          required: true,
          defaultValue: defaultDir,
          options: directories.map(d => ({ label: d === '.' ? '(root)' : d, value: d })),
        },
        {
          name: 'fileName',
          label: 'File name',
          type: 'text' as const,
          required: true,
          placeholder: `my-prompt (or my-prompt${this.fileType.defaultFileExtension})`,
        },
        {
          name: 'name',
          label: 'Prompt name',
          type: 'text' as const,
          required: false,
          placeholder: 'Default: file name without extension',
        },
      ],
    };
  }

  watch(callback: (event: PromptChangeEvent) => void): () => void {
    return this.fileProvider.watch(
      this.includePatterns,
      { cwd: this.rootDir, ignored: this.ignorePatterns },
      async (eventType, filePath) => {
        const absolutePath = this.resolveFilePath(filePath);
        if (this.consumeSuppressedWatchEvent(absolutePath, eventType)) {
          return;
        }

        if (eventType === 'change' || eventType === 'add') {
          if (this.files && !this.files.includes(absolutePath)) {
            this.files.push(absolutePath);
          }
          const prompts = await this.fileType.parsePrompts([absolutePath], this.rootDir);
          prompts.forEach(prompt => {
            callback({ type: eventType === 'change' ? 'change' : 'add', promptId: prompt.id });
          });
        } else {
          if (this.files) {
            this.files = this.files.filter(f => f !== absolutePath);
          }
          // filePath is relative to rootDir (chokidar cwd)
          callback({ type: 'remove', promptId: filePath });
        }
      }
    );
  }

  private async ensureFiles(): Promise<void> {
    if (!this.files) {
      this.files = await Array.fromAsync(this.findPromptFiles());
    }
  }

  private suppressNextWatchEvent(filePath: string, eventType: ChangeEventType): void {
    if (eventType !== 'change' && eventType !== 'add') return;
    const key = `${eventType}:${filePath}`;
    const entry = this.suppressedWatchEvents.get(key);
    this.suppressedWatchEvents.set(key, {
      remaining: (entry?.remaining ?? 0) + 1,
      expiresAt: Date.now() + 2000,
    });
  }

  private consumeSuppressedWatchEvent(filePath: string, eventType: ChangeEventType): boolean {
    const key = `${eventType}:${filePath}`;
    const entry = this.suppressedWatchEvents.get(key);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.suppressedWatchEvents.delete(key);
      return false;
    }
    if (entry.remaining <= 1) {
      this.suppressedWatchEvents.delete(key);
    } else {
      this.suppressedWatchEvents.set(key, {
        remaining: entry.remaining - 1,
        expiresAt: entry.expiresAt,
      });
    }
    return true;
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

  private async listDirectories(): Promise<string[]> {
    const dirs = new Set<string>(['.']);
    const iter = this.fileProvider.glob('**/', {
      cwd: this.rootDir,
      ignore: this.ignorePatterns,
    });
    for await (const dir of iter) {
      // glob yields trailing-slash paths like "src/prompts/"
      const clean = dir.replace(/\/$/, '');
      if (clean) dirs.add(clean);
    }
    return Array.from(dirs).sort();
  }

  private resolveFilePath(relativePath: string): string {
    if (relativePath.startsWith('/')) {
      return relativePath;
    }
    return `${this.rootDir}/${relativePath}`;
  }
}
