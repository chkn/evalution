import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONFIG_FILE_RELATIVE_PATH,
  configFileTemplate,
  type AiSdkChoice,
} from '../shared/config-template.ts';

/** Result of {@link scaffoldConfigFile}. */
export interface ScaffoldConfigResult {
  /** The config path that was written, relative to the project root. */
  path: string;
  /** Always `true` on success; the call throws if the file already exists. */
  created: boolean;
}

/**
 * Writes a starter `.evalution/config.ts` under `rootPath` for the chosen AI
 * SDK, creating the `.evalution` directory as needed.
 *
 * Refuses to clobber an existing config: if the file is already present the
 * call rejects, leaving the user's file untouched.
 */
export async function scaffoldConfigFile(
  rootPath: string,
  sdk: AiSdkChoice,
): Promise<ScaffoldConfigResult> {
  const filePath = path.join(rootPath, CONFIG_FILE_RELATIVE_PATH);

  try {
    await fs.access(filePath);
    throw new Error(`${CONFIG_FILE_RELATIVE_PATH} already exists`);
  } catch (err: any) {
    // ENOENT is the happy path (no existing file); anything else propagates.
    if (err?.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, configFileTemplate(sdk), 'utf8');
  return { path: CONFIG_FILE_RELATIVE_PATH, created: true };
}
