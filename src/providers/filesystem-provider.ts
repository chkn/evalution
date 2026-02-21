import type { PromptProvider, PromptChangeEvent } from './prompt-provider.ts';
import type { ParsedPrompt } from '../shared/types.ts';
import { PromptParser } from '../parser/prompt-parser.ts';
import { PromptEditor } from '../parser/prompt-editor.ts';
import { FileScanner } from '../cli/file-scanner.ts';
import chokidar from 'chokidar';

export class FileSystemPromptProvider implements PromptProvider {
  private parser: PromptParser | null = null;
  private files: string[] = [];
  private rootDir: string;
  private editor: PromptEditor;
  private scanner: FileScanner;

  constructor(
    rootDir: string,
    editor: PromptEditor,
    scanner: FileScanner
  ) {
    this.rootDir = rootDir;
    this.editor = editor;
    this.scanner = scanner;
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

    const [filePath] = this.parsePromptId(promptId);

    for (const [propertyName, value] of Object.entries(updates)) {
      const prop = prompt.properties[propertyName];
      if (!prop) {
        throw new Error(`Property '${propertyName}' not found`);
      }

      if (!prop.isEditable) {
        throw new Error(`Property '${propertyName}' is not editable`);
      }

      if (!prop.sourceSpan) {
        throw new Error(`Property '${propertyName}' is missing source metadata`);
      }

      await this.editor.updateProperty(filePath, prop, value);
    }

    // Re-scan and re-parse to get updated prompt
    await this.refresh();
    return (await this.getPrompt(promptId))!;
  }

  watch(callback: (event: PromptChangeEvent) => void): () => void {
    const patterns = ['**/*.prompt.ts', '**/*.promp.ts'];
    const watcher = chokidar.watch(patterns, {
      cwd: this.rootDir,
      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
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
      const absolutePath = this.resolveFilePath(filePath);
      callback({ type: 'remove', promptId: absolutePath });
    });

    return () => watcher.close();
  }

  private async ensureParser(): Promise<void> {
    if (!this.parser) {
      await this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    this.files = await this.scanner.findPromptFiles(this.rootDir);
    this.parser = new PromptParser(this.files);
  }

  private parsePromptId(id: string): [string, string] {
    const parts = id.split('#');
    if (parts.length !== 2) {
      throw new Error(`Invalid prompt ID format: ${id}`);
    }
    return [parts[0], parts[1]];
  }

  private resolveFilePath(relativePath: string): string {
    // If already absolute, return as is
    if (relativePath.startsWith('/')) {
      return relativePath;
    }

    // Resolve relative to rootDir
    return `${this.rootDir}/${relativePath}`;
  }
}
