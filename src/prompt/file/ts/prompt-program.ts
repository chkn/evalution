// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import ts from "typescript";

/**
 * A parsed view of one or more prompt files backed by a real
 * {@link ts.Program}, so extraction can consult a {@link ts.TypeChecker}.
 *
 * The checker is what lets parameter types resolve through constructs the
 * syntax tree alone cannot follow: types imported from other files, generic
 * instantiations, and utility types such as `Pick`/`Omit`/`Partial`.
 */
export interface PromptProgram {
  /** The source file for `filePath`, as parsed into the program. */
  getSourceFile(filePath: string): ts.SourceFile | undefined;
  /** Checker covering every file in the program. */
  typeChecker: ts.TypeChecker;
  /** The underlying program, passed back in as `previous` on the next build. */
  program: ts.Program;
}

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  skipLibCheck: true,
  noEmit: true,
};

/** Parsed declaration files that are stable for the lifetime of the process. */
const immutableSourceFiles = new Map<string, ts.SourceFile>();

const TS_LIB_DIR = path.dirname(ts.getDefaultLibFilePath({}));

/** Whether `fileName` names a file that will not change while we run. */
function isImmutable(fileName: string): boolean {
  return fileName.startsWith(TS_LIB_DIR) || fileName.includes("/node_modules/");
}

/**
 * Load the compiler options from the nearest `tsconfig.json` at or above
 * `fromPath`, so imports that rely on the project's `paths` aliases and
 * `moduleResolution` settings resolve the way they do for the user's own build.
 */
function compilerOptionsFor(fromPath: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(
    path.dirname(fromPath),
    ts.sys.fileExists,
  );
  if (!configPath) return FALLBACK_OPTIONS;

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) return FALLBACK_OPTIONS;

  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(configPath),
  );
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

/**
 * Build a {@link PromptProgram} over `sources`, a map of absolute file path to
 * that file's current content.
 *
 * `sources` is an overlay: those files are used as given (so unsaved edits are
 * seen), while everything they import is read from disk. Imports therefore
 * resolve only for files that exist on the real filesystem — with an in-memory
 * {@link FileProvider} the prompt files themselves still parse, but their
 * cross-file types stay unresolved and extraction falls back to the syntax
 * tree.
 *
 * @param sources - Prompt files to root the program at, keyed by absolute path.
 * @param previous - The program from a prior build. Passing it lets TypeScript
 *   reuse source files that have not changed, which keeps re-parsing on watch
 *   events far cheaper than building from scratch.
 */
export function createPromptProgram(
  sources: ReadonlyMap<string, string>,
  previous?: ts.Program,
): PromptProgram | undefined {
  const rootNames = [...sources.keys()];
  if (rootNames.length === 0) return undefined;

  const options = compilerOptionsFor(rootNames[0]);
  const host = ts.createCompilerHost(options, true);

  const { getSourceFile, readFile, fileExists } = host;

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const overlaid = sources.get(fileName);
    if (overlaid !== undefined) {
      return ts.createSourceFile(fileName, overlaid, languageVersion, true);
    }

    const cached = immutableSourceFiles.get(fileName);
    if (cached) return cached;

    const parsed = getSourceFile.call(
      host,
      fileName,
      languageVersion,
      onError,
      shouldCreate,
    );
    // Declaration files in the TypeScript lib and in node_modules don't change
    // while the server is running, and re-parsing them dominates the cost of
    // building a program, so they are worth holding on to.
    if (parsed && isImmutable(fileName)) {
      immutableSourceFiles.set(fileName, parsed);
    }
    return parsed;
  };
  host.readFile = fileName =>
    sources.get(fileName) ?? readFile.call(host, fileName);
  host.fileExists = fileName =>
    sources.has(fileName) || fileExists.call(host, fileName);

  const program = ts.createProgram({
    rootNames,
    options,
    host,
    oldProgram: previous,
  });

  return {
    program,
    typeChecker: program.getTypeChecker(),
    getSourceFile: filePath => program.getSourceFile(filePath),
  };
}
