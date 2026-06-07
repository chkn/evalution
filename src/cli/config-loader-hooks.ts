import module from 'node:module';

/**
 * Registers an in-thread module-resolution hook so a project's
 * `.evalution/config.ts` can import the framework by bare specifier
 * (`import { FilePromptProvider } from 'evalution'`) regardless of where it
 * lives or whether evalution is installed in the project's `node_modules`.
 *
 * By default Node resolves `evalution` against the config file's directory,
 * which fails when evalution is run via `npx` (or pointed at another directory)
 * and isn't installed locally. This hook redirects the `evalution` specifier
 * (and its subpaths) to resolve from the running CLI instead, so the config
 * always binds to the same evalution the CLI is executing — no local install
 * required.
 *
 * Uses {@link https://nodejs.org/api/module.html#moduleregisterhooksoptions | `module.registerHooks`}
 * (synchronous, same-thread) rather than `module.register`, so it needs no
 * separate loader file — it survives bundling and behaves identically whether
 * the CLI runs from source (dev) or the compiled bundle (published).
 *
 * @param parentURL - Module URL the `evalution` specifier is resolved against;
 *   pass the CLI's own `import.meta.url`.
 */
export function registerEvalutionResolver(parentURL: string): void {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'evalution' || specifier.startsWith('evalution/')) {
        return nextResolve(specifier, { ...context, parentURL });
      }
      return nextResolve(specifier, context);
    },
  });
}
