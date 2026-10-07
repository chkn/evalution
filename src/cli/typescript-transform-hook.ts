// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import module from "node:module";
import ts from "typescript";

/**
 * Erases `source`'s types exactly as Node's loader would, without the
 * one-time `ExperimentalWarning` the public API prints for it — the loader
 * itself prints none, and evalution's users didn't ask for it. Throws
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` for syntax that needs compiling.
 */
function stripTypes(source: string): string {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.startsWith("stripTypeScriptTypes is an experimental")) return;
    return (emitWarning as any).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return module.stripTypeScriptTypes(source);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Compiles TypeScript that needs more than type stripping — parameter
 * properties, enums, namespaces — to JavaScript of the given module format.
 * The source map is inlined, so `--enable-source-maps` still points stack
 * traces at the original lines.
 */
function transpile(source: string, fileName: string, commonjs: boolean) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: commonjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      inlineSourceMap: true,
      inlineSources: true,
    },
  }).outputText;
}

/**
 * Registers an in-thread load hook that compiles a TypeScript module with
 * the `typescript` package when Node's own type stripping would reject it
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
 *
 * Prompt files (and whatever they import) run through Node's own loader,
 * which only erases types; it cannot run syntax that has runtime semantics.
 * Consumer projects are commonly authored for `tsc` or a bundler, which
 * accept it. Node strips types after the load hooks have run, so this hook
 * strips them itself — the same transform, so modules Node could load run
 * exactly as before — and only compiles the ones that fails for.
 *
 * Register it after the variation loader hook: hooks run last-registered
 * first, so it then also sees a variation's in-memory source.
 */
export function registerTypeScriptTransformFallback(): void {
  module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (
        (result.format !== "module-typescript" &&
          result.format !== "commonjs-typescript") ||
        result.source == null
      ) {
        return result;
      }
      const commonjs = result.format === "commonjs-typescript";
      const source =
        typeof result.source === "string"
          ? result.source
          : new TextDecoder().decode(result.source);
      try {
        return {
          ...result,
          format: commonjs ? "commonjs" : "module",
          source: stripTypes(source),
        };
      } catch (err: any) {
        if (err?.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw err;
        return {
          ...result,
          format: commonjs ? "commonjs" : "module",
          source: transpile(source, new URL(url).pathname, commonjs),
        };
      }
    },
  });
}
