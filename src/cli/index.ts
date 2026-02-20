import { FileScanner } from './file-scanner.ts';
import { PromptEditor } from '../parser/prompt-editor.ts';
import { FileSystemPromptProvider } from '../providers/filesystem-provider.ts';
import { startServer } from '../server/index.ts';

async function main() {
  const cwd = process.cwd();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  console.log('🔍 Scanning for .prompt.ts files...');

  // Create filesystem provider (default)
  const scanner = new FileScanner();
  const editor = new PromptEditor();
  const provider = new FileSystemPromptProvider(cwd, editor, scanner);

  // Check if there are any prompt files
  const files = await scanner.findPromptFiles(cwd);

  if (files.length === 0) {
    console.log('\n❌ No prompt files found in the current directory.');
    console.log('Create a .prompt.ts file to get started.\n');
    console.log('Example:');
    console.log('```typescript');
    console.log("import { openai } from '@ai-sdk/openai';");
    console.log('');
    console.log('export function myPrompt() {');
    console.log('  return {');
    console.log("    model: openai('gpt-4o'),");
    console.log("    system: 'You are a helpful assistant',");
    console.log("    messages: [{ role: 'user', content: 'Hello!' }]");
    console.log('  };');
    console.log('}');
    console.log('```\n');
    process.exit(1);
  }

  console.log(`✅ Found ${files.length} prompt file(s)\n`);

  // Start server
  await startServer({ provider, port });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
