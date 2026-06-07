import path from 'path';
import fs from 'fs/promises';
import module from 'node:module';
import { pathToFileURL } from 'url';
import type { EvalutionConfig } from '../config.ts';
import { MemoryTraceProvider } from '../trace/memory-trace-provider.ts';
import { startServer } from '../server/index.ts';
import { watchForConfigCreation } from './config-watcher.ts';

// Make a project's config resolve `import ... from 'evalution'` against this
// CLI rather than the project's node_modules, so configs load even when
// evalution is run via `npx` with no local install. Registered once, up front,
// before any config import happens.
module.register('./config-loader-hooks.ts', import.meta.url, {
  data: { parentURL: import.meta.url },
});

async function findRootDir(startDir: string): Promise<{ rootDir: string; hasConfig: boolean }> {
  let dir = startDir;
  while (true) {
    const configPath = path.join(dir, '.evalution', 'config.ts');
    try {
      await fs.access(configPath);
      return { rootDir: dir, hasConfig: true };
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { rootDir: startDir, hasConfig: false };
}

async function loadConfig(rootDir: string): Promise<EvalutionConfig> {
  const configPath = path.join(rootDir, '.evalution', 'config.ts');
  process.chdir(rootDir);
  const mod = await import(pathToFileURL(configPath).href);
  console.log(`⚙️ Loaded config from ${configPath}`);
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

function startConfiguredServer(rootDir: string, config: EvalutionConfig, hasConfig: boolean) {
  if (config.useDotenv !== false) {
    applyDotenv(rootDir);
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const promptProviders = config.promptProviders ?? [];
  const traceProviders = config.traceProviders ?? [new MemoryTraceProvider()];

  return startServer({ promptProviders, traceProviders, port, rootPath: rootDir, hasConfig });
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
  const startDir = pathArg ? path.resolve(pathArg) : process.cwd();
  const { rootDir, hasConfig } = await findRootDir(startDir);

  if (hasConfig) {
    await startConfiguredServer(rootDir, await loadConfig(rootDir), true);
    return;
  }

  // No config yet: start in onboarding mode with defaults so the UI (and its
  // `POST /api/config/create` route) is reachable, then watch for the config
  // file to appear and restart the server with the real config once it does.
  let server = await startConfiguredServer(rootDir, {}, false);
  console.log(`👀 No config found; watching ${path.join(rootDir, '.evalution', 'config.ts')} for creation...`);

  const stopWatching = watchForConfigCreation(rootDir, async () => {
    // Load before tearing anything down: if the config is broken (e.g. a bad
    // import), this throws, the watcher logs it, and the onboarding server
    // stays up so the user can fix the file and have it retried.
    const config = await loadConfig(rootDir);
    console.log('⚙️ Config loaded; restarting server...');
    stopWatching();
    await server.close();
    server = await startConfiguredServer(rootDir, config, true);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
