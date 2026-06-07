/**
 * ESM module-resolution hooks, registered via {@link https://nodejs.org/api/module.html#moduleregisterspecifier-parenturl-options | `module.register`}
 * before a project's `.evalution/config.ts` is imported.
 *
 * A generated config imports the framework with a bare specifier
 * (`import { FilePromptProvider } from 'evalution'`). By default Node resolves
 * that against the config file's directory, which fails when evalution is run
 * via `npx` (or pointed at another directory) and isn't installed in the
 * project's `node_modules`. These hooks redirect the `evalution` specifier to
 * resolve from the running CLI instead, so the config always binds to the same
 * evalution the CLI is executing — no local install required.
 *
 * This module runs in a separate loader thread, so it shares no state with the
 * main module; the CLI's location is handed over through {@link initialize}.
 */

/** Module URL the `evalution` specifier is resolved against (the running CLI). */
let parentURL: string | undefined;

/** Context passed to the {@link resolve} hook by Node's module loader. */
interface ResolveContext {
  conditions: string[];
  importAttributes: Record<string, string>;
  parentURL?: string;
}

/** Result returned from a `resolve` hook. */
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
  importAttributes?: Record<string, string>;
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

/**
 * Receives the data passed to `module.register`. Called once when the hooks are
 * registered.
 *
 * @param data - Carries the CLI's module URL to anchor `evalution` resolution.
 */
export async function initialize(data: { parentURL: string }): Promise<void> {
  parentURL = data.parentURL;
}

/**
 * Resolve hook: redirects `evalution` (and its subpaths) to resolve from the
 * CLI, and defers everything else to the default resolver.
 */
export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  if (parentURL && (specifier === 'evalution' || specifier.startsWith('evalution/'))) {
    return nextResolve(specifier, { ...context, parentURL });
  }
  return nextResolve(specifier, context);
}
