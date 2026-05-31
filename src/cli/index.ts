import path from 'path';
import fs from 'fs/promises';
import { pathToFileURL } from 'url';
import type { EvalutionConfig } from '../config.ts';
import { FilePromptProvider } from '../prompt/file/file-prompt-provider.ts';
import { MemoryTraceProvider } from '../trace/memory-trace-provider.ts';
import { startServer } from '../server/index.ts';

async function loadConfig(rootDir: string): Promise<EvalutionConfig> {
  const configPath = path.join(rootDir, '.evalution', 'config.ts');
  try {
    await fs.access(configPath);
  } catch {
    return {};
  }

  process.chdir(rootDir);
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default ?? {};
}

function applyDotenv(rootDir: string): void {
  const envPath = path.join(rootDir, '.env');
  try {
    process.loadEnvFile(envPath);
    console.log(`📄 Loaded environment variables from ${envPath}`);
  } catch (err: any) {
    // Missing .env is fine; any other error is worth surfacing.
    if (err?.code !== 'ENOENT') {
      console.warn(`Warning: failed to load .env from ${envPath}:`, err.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Accept: (no args) | "ui" | "ui <path>"
  if (args.length > 0 && args[0] !== 'ui') {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Usage: evalution [ui [path]]');
    process.exit(1);
  }

  const pathArg = args[1];
  const rootDir = pathArg ? path.resolve(pathArg) : process.cwd();

  const config = await loadConfig(rootDir);
  if (config.useDotenv !== false) {
    applyDotenv(rootDir);
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const promptProviders = config.promptProviders ?? [new FilePromptProvider({ rootDir })];
  const traceProviders = config.traceProviders ?? [new MemoryTraceProvider()];

  await startServer({ promptProviders, traceProviders, port, rootPath: rootDir });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
