import type { ParsedPrompt, PromptProperty } from '../../shared/types.ts';
import { PromptParser } from '../../parser/prompt-parser.ts';
import { PromptEditor } from '../../parser/prompt-editor.ts';
import { LocalFileProvider, type FileProvider } from './file-provider.ts';

export interface PromptFileParser {
  parseAll(): ParsedPrompt[];
  parseFile(filePath: string): ParsedPrompt[];
}

export interface PromptFileType {
  defaultIncludePatterns: readonly string[];

  createParser(files: string[], rootDir: string): Promise<PromptFileParser>;

  updateProperty(filePath: string, prop: PromptProperty, value: any): Promise<void>;
  removeProperty(filePath: string, prop: PromptProperty): Promise<void>;
  addProperty(filePath: string, promptName: string, propertyName: string, value: any): Promise<void>;

  // Load the prompt by name from a file and invoke it with params to produce a config object
  loadConfig(filePath: string, promptName: string, params: any[]): Promise<any>;
}

export class TSPromptFileType implements PromptFileType {
  defaultIncludePatterns = ['**/*.prompt.ts', '**/*.promp.ts'];

  private editor: PromptEditor;
  private fileProvider: FileProvider;

  constructor(fileProvider: FileProvider = new LocalFileProvider()) {
    this.fileProvider = fileProvider;
    this.editor = new PromptEditor(fileProvider);
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
