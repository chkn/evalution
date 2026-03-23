import { PromptEditor } from '../../../parser/prompt-editor.ts';
import { type PromptFileParser, PromptParser } from '../../../parser/prompt-parser.ts';
import { type FileProvider, LocalFileProvider } from '../../../server/file-provider.ts';
import type { PromptProperty } from '../../../shared/types.ts';
import type { PromptFileType } from '../prompt-file-type.ts';

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
