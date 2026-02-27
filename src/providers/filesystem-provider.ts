import { glob } from 'glob';
import path from 'path';
import { pathToFileURL } from 'url';
import { generateText, streamText } from 'ai';
import type { PromptProvider, PromptChangeEvent } from './prompt-provider.ts';
import type { ParsedPrompt } from '../shared/types.ts';
import { PromptParser } from '../parser/prompt-parser.ts';
import { PromptEditor } from '../parser/prompt-editor.ts';
import chokidar from 'chokidar';

const DEFAULT_INCLUDE_PATTERNS = ['**/*.prompt.ts', '**/*.promp.ts'];
const DEFAULT_IGNORE_PATTERNS = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

export interface FileSystemPromptProviderOptions {
  id?: string;
  rootDir?: string;
  editor?: PromptEditor;
  includePatterns?: string[];
  ignorePatterns?: string[];
}

let defaultIDCounter = 0;

export class FileSystemPromptProvider implements PromptProvider {
  readonly id: string;
  private parser: PromptParser | null = null;
  private rootDir: string;
  private editor: PromptEditor;
  private includePatterns: string[];
  private ignorePatterns: string[];

  constructor({
    id = 'fs' + (defaultIDCounter++ ? defaultIDCounter : ''), // ensure unique default IDs for multiple instances
    rootDir = process.cwd(),
    editor = new PromptEditor(),
    includePatterns = DEFAULT_INCLUDE_PATTERNS,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
  }: FileSystemPromptProviderOptions = {}) {
    this.id = id;
    this.rootDir = rootDir;
    this.editor = editor;
    this.includePatterns = includePatterns;
    this.ignorePatterns = ignorePatterns;
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

    const [filePath, functionName] = this.parsePromptId(promptId);

    for (const [propertyName, value] of Object.entries(updates)) {
      const prop = prompt.properties[propertyName];

      if (value === null) {
        // null → remove the property
        if (!prop) throw new Error(`Property '${propertyName}' not found`);
        await this.editor.removeProperty(filePath, prop);
      } else if (!prop) {
        // unknown key → add as a new property
        await this.editor.addProperty(filePath, functionName, propertyName, value);
      } else {
        // existing key → update in place
        if (!prop.isEditable) {
          throw new Error(`Property '${propertyName}' is not editable`);
        }
        if (!prop.valueSpan) {
          throw new Error(`Property '${propertyName}' is missing source metadata`);
        }
        await this.editor.updateProperty(filePath, prop, value);
      }
    }

    // Re-scan and re-parse to get updated prompt
    await this.refresh();
    return (await this.getPrompt(promptId))!;
  }

  async execute(promptId: string, params: any[], stream: boolean): Promise<any> {
    const [filePath, functionName] = this.parsePromptId(promptId);
    const module = await import(pathToFileURL(filePath).href);
    const promptFunction = module[functionName];

    if (typeof promptFunction !== 'function') {
      throw new Error(`Function '${functionName}' not found in ${filePath}`);
    }

    const config = promptFunction(...params);

    if (!config || typeof config !== 'object') {
      throw new Error(`Function '${functionName}' did not return a valid config object`);
    }

    if (stream) {
      const result = await streamText(config);
      return result.textStream;
    } else {
      const result = await generateText(config);
      return { text: result.text, usage: result.usage, finishReason: result.finishReason };
    }
  }

  watch(callback: (event: PromptChangeEvent) => void): () => void {
    const watcher = chokidar.watch(this.includePatterns, {
      cwd: this.rootDir,
      ignored: this.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', async (filePath) => {
      const absolutePath = this.resolveFilePath(filePath);
      await this.refresh();

      // Determine which prompts changed
      const prompts = this.parser!.parseFile(absolutePath);
      prompts.forEach(prompt => {
        callback({ type: 'change', promptId: prompt.id });
      });
    });

    watcher.on('add', async (filePath) => {
      const absolutePath = this.resolveFilePath(filePath);
      await this.refresh();

      const prompts = this.parser!.parseFile(absolutePath);
      prompts.forEach(prompt => {
        callback({ type: 'add', promptId: prompt.id });
      });
    });

    watcher.on('unlink', (filePath) => {
      // filePath is already relative to rootDir (chokidar cwd)
      callback({ type: 'remove', promptId: filePath });
    });

    return () => watcher.close();
  }

  private async ensureParser(): Promise<void> {
    if (!this.parser) {
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    const files = await this.findPromptFiles();
    this.parser = new PromptParser(files, this.rootDir);
  }

  private async findPromptFiles(): Promise<string[]> {
    const allFiles: string[] = [];

    for (const pattern of this.includePatterns) {
      const files = await glob(pattern, {
        cwd: this.rootDir,
        absolute: true,
        ignore: this.ignorePatterns,
      });
      allFiles.push(...files);
    }

    const uniqueFiles = Array.from(new Set(allFiles));
    return uniqueFiles.sort();
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
