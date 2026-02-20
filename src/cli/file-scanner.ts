import { glob } from 'glob';
import path from 'path';

export class FileScanner {
  async findPromptFiles(rootDir: string): Promise<string[]> {
    const patterns = ['**/*.prompt.ts', '**/*.promp.ts'];
    const ignore = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

    const allFiles: string[] = [];

    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: rootDir,
        absolute: true,
        ignore,
      });
      allFiles.push(...files);
    }

    // Remove duplicates and sort
    const uniqueFiles = Array.from(new Set(allFiles));
    return uniqueFiles.sort();
  }
}
