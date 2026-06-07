import path from 'node:path';
import chokidar from 'chokidar';
import { CONFIG_FILE_RELATIVE_PATH } from '../shared/config-template.ts';

/**
 * Watches `rootDir` for `.evalution/config.ts` appearing or changing and runs
 * `onConfig` each time, awaiting it so failures surface rather than vanishing.
 *
 * Used when the server starts without a config file: the onboarding UI (via
 * `POST /api/config/create`) writes the config, and this watcher lets the CLI
 * pick it up and restart with the real config.
 *
 * Rather than watch the not-yet-existing nested config path directly, this
 * watches `rootDir` and ignores everything except the `.evalution` directory
 * and the config file itself, so the watcher reliably fires when the directory
 * and file are created together while never descending into `node_modules` and
 * friends.
 *
 * `onConfig` may be async; it is awaited and any rejection is logged instead of
 * becoming an unhandled rejection. The watcher keeps firing on subsequent
 * changes (overlapping runs are skipped), so if a load fails — e.g. the config
 * has a bad import — the user can fix the file and have it retried. The caller
 * is expected to stop the watcher (via the returned function) once the config
 * has loaded successfully.
 *
 * @param rootDir - The project root that will contain `.evalution/config.ts`.
 * @param onConfig - Run when the config file is created or changed.
 * @returns A function that stops watching.
 */
export function watchForConfigCreation(
  rootDir: string,
  onConfig: () => void | Promise<void>,
): () => void {
  const configPath = path.join(rootDir, CONFIG_FILE_RELATIVE_PATH);
  const configDir = path.dirname(configPath);

  // Only these three paths matter; ignoring the rest keeps the watch cheap and
  // prevents chokidar from recursing into large sibling directories.
  const allowed = new Set([rootDir, configDir, configPath]);

  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 2,
    ignored: (p: string) => !allowed.has(p),
  });

  let running = false;
  const handle = async (p: string) => {
    if (p !== configPath || running) return;
    running = true;
    try {
      await onConfig();
    } catch (err) {
      console.error(`Failed to load config from ${configPath}:`, err);
    } finally {
      running = false;
    }
  };

  watcher.on('add', handle);
  watcher.on('change', handle);

  return () => { void watcher.close(); };
}
