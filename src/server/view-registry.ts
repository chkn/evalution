// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Finds a project's views and bundles each for its frame. Views are browser
 * modules: the server finds and builds them but never imports them. Each
 * file under `.evalution/views/<surface>/` is one view, built on its own so
 * a broken file can't take the others with it. See
 * `specs/trace-visualizers.md` §B.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Metafile, Plugin } from "esbuild";
import type { FileProvider } from "../file-provider.ts";
import type { ViewInfo, ViewList, ViewModuleError } from "../shared/types.ts";
import {
  isSurfaceName,
  SURFACE_NAMES,
  VIEWS_DIR,
} from "../shared/view-surfaces.ts";

/** Patterns matching every surface's view files. */
export const DEFAULT_VIEW_INCLUDE_PATTERNS = SURFACE_NAMES.map(
  name => `${VIEWS_DIR}/${name}/**/*.{ts,tsx}`,
);

/** The specifiers a view's bundle resolves to the running evalution, not the project's. */
export type RuntimeEntries = Record<
  "evalution/views" | "evalution/views/react" | "evalution/views/datasets",
  string
>;

/**
 * Where the running copy of evalution keeps the views runtime: its source
 * when run from source, its build otherwise. A bundle always takes the
 * runtime from here, so it speaks the host's protocol.
 */
export function runningRuntimeEntries(
  moduleUrl: string = import.meta.url,
): RuntimeEntries {
  const modulePath = fileURLToPath(moduleUrl);
  let root = path.dirname(modulePath);
  for (;;) {
    const manifest = path.join(root, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "evalution")
          break;
      } catch {
        /* keep looking */
      }
    }
    const parent = path.dirname(root);
    if (parent === root) {
      throw new Error(`Can't find evalution's package root from ${modulePath}`);
    }
    root = parent;
  }
  const fromSource = modulePath.startsWith(path.join(root, "src") + path.sep);
  return fromSource
    ? {
        "evalution/views": path.join(root, "src/views/index.ts"),
        "evalution/views/react": path.join(root, "src/views/react/index.tsx"),
        "evalution/views/datasets": path.join(
          root,
          "src/views/datasets/index.ts",
        ),
      }
    : {
        "evalution/views": path.join(root, "dist/views/index.js"),
        "evalution/views/react": path.join(root, "dist/views/react/index.js"),
        "evalution/views/datasets": path.join(
          root,
          "dist/views/datasets/index.js",
        ),
      };
}

/** A view that built: what its frame serves. */
export interface ViewBundle {
  uri: string;
  surface: string;
  moduleVersion: string;
  /** The bundle: one self-contained ES module. */
  code: string;
}

/** One discovered view file, built or not. */
interface Entry {
  uri: string;
  /** Absolute path. */
  modulePath: string;
  surface: string;
  result: { bundle: ViewBundle } | { error: string };
  /** Absolute paths of the project files the build read, the module included. */
  inputs: Set<string>;
}

/** The namespace project files are loaded in, through the `FileProvider`. */
const PROJECT_NAMESPACE = "evalution-project";

/** Extensions tried, in order, for an import that names none. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

/** Files whose change can change a bundle. */
const WATCH_PATTERNS = [
  ".evalution/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}",
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}",
];
const WATCH_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  ".evalution/{traces,datasets,evals,variations,run}/**",
];

const NODE_BUILTINS = new Set(builtinModules);

/** Why a view can't import `specifier`, a Node built-in. */
export function nodeImportMessage(specifier: string): string {
  return (
    `Imports "${specifier}", which only exists on the server: a view runs in the browser. ` +
    "Was server-only code imported by accident? Keep what the view needs in a module " +
    "that doesn't use Node, such as one under .evalution/shared/."
  );
}

/** Why a view can't import `specifier` from React. */
export function reactMissingMessage(specifier: string): string {
  return (
    `Imports "${specifier}", but React isn't installed in this project. ` +
    "evalution/views/react uses your project's React: install it with `npm install react react-dom`."
  );
}

const loaderFor = (file: string) => {
  const ext = path.extname(file);
  if (ext === ".tsx") return "tsx" as const;
  if (ext === ".jsx") return "jsx" as const;
  if (ext === ".json") return "json" as const;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js" as const;
  return "ts" as const;
};

/** What a {@link ViewRegistry} takes. */
export interface ViewRegistryOptions {
  /** Where project files are read from — so unsaved overlay edits count. */
  fileProvider: FileProvider;
  /** The project's root directory. */
  rootDir: string;
  /** Defaults to {@link runningRuntimeEntries}. */
  runtime?: RuntimeEntries;
}

/**
 * A project's views: discovered under `.evalution/views/<surface>/`, each
 * built into its own bundle with esbuild (loaded only once there's a view
 * to build), and rebuilt when it or anything it imports changes.
 */
export class ViewRegistry {
  private readonly fileProvider: FileProvider;
  private readonly rootDir: string;
  private readonly runtime: RuntimeEntries;
  /** Built entries by uri, or `null` before the first scan. */
  private entries: Map<string, Entry> | null = null;
  /** Files outside any surface's directory, by uri. */
  private misplaced: ViewModuleError[] = [];
  /** The work in flight; everything waits on it. */
  private work: Promise<void> = Promise.resolve();
  /** What the next refresh must do: rescan, or rebuild these uris. */
  private pending: { rescan: boolean; dirty: Set<string> } | null = null;
  private versionNumber = 0;
  private signature = "";
  private listeners = new Set<(version: number) => void>();
  private unwatch: (() => void) | undefined;

  constructor({ fileProvider, rootDir, runtime }: ViewRegistryOptions) {
    this.fileProvider = fileProvider;
    this.rootDir = rootDir;
    this.runtime = runtime ?? runningRuntimeEntries();
  }

  /** Every view, and every view file that can't be shown. */
  async list(): Promise<ViewList> {
    await this.ready();
    const views: ViewInfo[] = [];
    const errors: ViewModuleError[] = [...this.misplaced];
    for (const entry of this.entries!.values()) {
      if ("bundle" in entry.result) {
        views.push({
          uri: entry.uri,
          surface: entry.surface,
          moduleVersion: entry.result.bundle.moduleVersion,
        });
      } else {
        errors.push({
          uri: entry.uri,
          surface: entry.surface,
          message: entry.result.error,
        });
      }
    }
    views.sort((a, b) => a.uri.localeCompare(b.uri));
    errors.sort((a, b) => a.uri.localeCompare(b.uri));
    return { version: this.versionNumber, views, errors };
  }

  /** The bundle for the view at `uri`, or `undefined` if there's none that built. */
  async bundle(uri: string): Promise<ViewBundle | undefined> {
    await this.ready();
    const result = this.entries!.get(uri)?.result;
    return result && "bundle" in result ? result.bundle : undefined;
  }

  /**
   * Watches the project's files, rebuilding a view when it or anything it
   * imports changes, and calls `onChange` with the new version whenever
   * the list does. Returns the unsubscribe.
   */
  watch(onChange: (version: number) => void): () => void {
    this.listeners.add(onChange);
    this.unwatch ??= this.fileProvider.watch(
      WATCH_PATTERNS,
      { cwd: this.rootDir, ignored: WATCH_IGNORES },
      (type, relativePath) => this.fileChanged(type, relativePath),
    );
    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0) {
        this.unwatch?.();
        this.unwatch = undefined;
      }
    };
  }

  /** Settles once discovery, and any rebuild in flight, are done. */
  private async ready(): Promise<void> {
    if (!this.entries) this.schedule({ rescan: true });
    // Work can be scheduled while waiting; wait for that too.
    let seen: Promise<void>;
    do {
      seen = this.work;
      await seen;
    } while (seen !== this.work);
  }

  private fileChanged(type: string, relativePath: string): void {
    if (!this.entries) return;
    const rel = relativePath.replace(/\\/g, "/");
    const absolute = path.resolve(this.rootDir, rel);
    if (rel.startsWith(`${VIEWS_DIR}/`) && type !== "change") {
      this.schedule({ rescan: true });
      return;
    }
    const dirty = new Set<string>();
    for (const entry of this.entries.values()) {
      // A new file may be the import a failed build couldn't resolve.
      const retry = type === "add" && "error" in entry.result;
      if (retry || entry.inputs.has(absolute)) dirty.add(entry.uri);
    }
    if (dirty.size > 0) this.schedule({ rescan: false, dirty });
  }

  private schedule(request: { rescan: boolean; dirty?: Set<string> }): void {
    const queued = this.pending;
    if (queued) {
      queued.rescan ||= request.rescan;
      for (const uri of request.dirty ?? []) queued.dirty.add(uri);
      return;
    }
    this.pending = { rescan: request.rescan, dirty: new Set(request.dirty) };
    this.work = this.work.then(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    const request = this.pending;
    this.pending = null;
    if (!request) return;
    try {
      if (request.rescan || !this.entries) await this.rescan();
      else await this.rebuild(request.dirty);
    } catch (err) {
      console.warn("failed to build views:", err);
    }
    const signature = JSON.stringify(await this.snapshot());
    if (signature !== this.signature) {
      this.signature = signature;
      this.versionNumber++;
      for (const listener of this.listeners) listener(this.versionNumber);
    }
  }

  /** What the list says, for telling whether it changed. */
  private async snapshot() {
    return [
      [...(this.entries?.values() ?? [])].map(e => [
        e.uri,
        "bundle" in e.result ? e.result.bundle.moduleVersion : e.result.error,
      ]),
      this.misplaced,
    ];
  }

  private async discover(): Promise<{
    files: Entry[];
    misplaced: ViewModuleError[];
  }> {
    const files: Entry[] = [];
    const misplaced: ViewModuleError[] = [];
    const seen = new Set<string>();
    for (const pattern of [`${VIEWS_DIR}/**/*.ts`, `${VIEWS_DIR}/**/*.tsx`]) {
      for await (const modulePath of this.fileProvider.glob(pattern, {
        cwd: this.rootDir,
        absolute: true,
        ignore: ["**/node_modules/**", "**/*.d.ts"],
      })) {
        if (seen.has(modulePath)) continue;
        seen.add(modulePath);
        const uri = path.relative(this.rootDir, modulePath).replace(/\\/g, "/");
        const inside = uri.slice(VIEWS_DIR.length + 1).split("/");
        const [surface] = inside;
        if (inside.length < 2) {
          misplaced.push({
            uri,
            message: `Not in a surface's directory: put it in ${SURFACE_NAMES.map(s => `${VIEWS_DIR}/${s}/`).join(" or ")}.`,
          });
        } else if (!isSurfaceName(surface)) {
          misplaced.push({
            uri,
            surface,
            message: `There's no surface named "${surface}": views go in ${SURFACE_NAMES.map(s => `${VIEWS_DIR}/${s}/`).join(" or ")}.`,
          });
        } else {
          files.push({
            uri,
            modulePath,
            surface,
            result: { error: "not built yet" },
            inputs: new Set([modulePath]),
          });
        }
      }
    }
    return { files, misplaced };
  }

  private async rescan(): Promise<void> {
    const { files, misplaced } = await this.discover();
    await Promise.all(files.map(entry => this.build(entry)));
    this.entries = new Map(files.map(e => [e.uri, e]));
    this.misplaced = misplaced;
  }

  private async rebuild(uris: Set<string>): Promise<void> {
    await Promise.all(
      [...uris].map(uri => {
        const entry = this.entries?.get(uri);
        return entry && this.build(entry);
      }),
    );
  }

  /** Builds `entry`'s bundle, recording the result and the files it read. */
  private async build(entry: Entry): Promise<void> {
    const esbuild = await import("esbuild");
    const contents = [
      `import * as view from ${JSON.stringify(entry.modulePath)};`,
      `import { start } from "evalution/views";`,
      `start(view.default, ${JSON.stringify(entry.surface)});`,
    ].join("\n");
    try {
      const result = await esbuild.build({
        stdin: {
          contents,
          resolveDir: this.rootDir,
          sourcefile: "view-entry.js",
          loader: "js",
        },
        absWorkingDir: this.rootDir,
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        minify: true,
        metafile: true,
        logLevel: "silent",
        legalComments: "none",
        charset: "utf8",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        plugins: [this.plugin()],
      });
      const code = result.outputFiles[0]?.text ?? "";
      entry.inputs = this.projectInputs(result.metafile, entry.modulePath);
      entry.result = {
        bundle: {
          uri: entry.uri,
          surface: entry.surface,
          moduleVersion: createHash("sha256")
            .update(code)
            .digest("hex")
            .slice(0, 16),
          code,
        },
      };
    } catch (err) {
      const failure = err as { errors?: Message[] };
      entry.result = {
        error: failure.errors?.length
          ? this.formatErrors(failure.errors)
          : String((err as Error)?.message ?? err),
      };
      // Keep watching what the failed build read, so a fix rebuilds it.
      for (const file of this.erroredInputs(failure.errors ?? [])) {
        entry.inputs.add(file);
      }
    }
  }

  /** Whether `file` is one of the project's own files, read through the `FileProvider`. */
  private inProject(file: string): boolean {
    const rel = path.relative(this.rootDir, file);
    return (
      !rel.startsWith("..") &&
      !path.isAbsolute(rel) &&
      !rel.split(path.sep).includes("node_modules")
    );
  }

  /** The project file `base` names, trying TypeScript's extensions. */
  private async findProjectFile(base: string): Promise<string | undefined> {
    const exists = async (file: string) => {
      try {
        await this.fileProvider.readFile(file);
        return true;
      } catch {
        return false;
      }
    };
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const candidates = [
      ...(ext ? [base] : []),
      // `./foo.js` written for TypeScript means `./foo.ts`.
      ...(ext === ".js" ? [`${stem}.ts`, `${stem}.tsx`] : []),
      ...(ext === ".mjs" ? [`${stem}.mts`] : []),
      ...RESOLVE_EXTENSIONS.map(e => base + e),
      ...RESOLVE_EXTENSIONS.map(e => path.join(base, `index${e}`)),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }

  private plugin(): Plugin {
    const { rootDir } = this;
    const runtime = this.runtime;
    const fromProject = Symbol("fromProject");
    return {
      name: "evalution-views",
      setup: build => {
        // The running evalution's runtime, whatever the project has installed.
        build.onResolve(
          { filter: /^evalution\/views(\/react|\/datasets)?$/ },
          args => ({ path: runtime[args.path as keyof RuntimeEntries] }),
        );
        build.onResolve({ filter: /^node:/ }, args => ({
          errors: [{ text: nodeImportMessage(args.path) }],
        }));
        // React only ever comes from the project, so the adapter and the
        // view share one copy.
        build.onResolve({ filter: /^react(-dom)?(\/|$)/ }, async args => {
          if (args.pluginData === fromProject) return undefined;
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: rootDir,
            pluginData: fromProject,
          });
          if (result.errors.length > 0) {
            return { errors: [{ text: reactMissingMessage(args.path) }] };
          }
          return {
            path: result.path,
            namespace: result.namespace,
            ...(result.sideEffects === false && { sideEffects: false }),
          };
        });
        // The project's own files are read through the FileProvider.
        build.onResolve({ filter: /^(\.\.?\/|\/)/ }, async args => {
          const target = path.isAbsolute(args.path)
            ? args.path
            : path.resolve(args.resolveDir, args.path);
          if (!this.inProject(target)) return undefined;
          const found = await this.findProjectFile(target);
          return found
            ? { path: found, namespace: PROJECT_NAMESPACE }
            : undefined;
        });
        build.onLoad(
          { filter: /.*/, namespace: PROJECT_NAMESPACE },
          async args => ({
            contents: await this.fileProvider.readFile(args.path),
            loader: loaderFor(args.path),
            resolveDir: path.dirname(args.path),
          }),
        );
      },
    };
  }

  /** The project files a build read: what a change to must rebuild it. */
  private projectInputs(
    metafile: Metafile | undefined,
    modulePath: string,
  ): Set<string> {
    const inputs = new Set([modulePath]);
    for (const key of Object.keys(metafile?.inputs ?? {})) {
      const file = this.inputPath(key);
      if (file && this.inProject(file)) inputs.add(file);
    }
    return inputs;
  }

  /** A metafile or message path (`namespace:path`, or relative) as an absolute path. */
  private inputPath(key: string): string | undefined {
    const match = /^([a-z-]+):(.*)$/.exec(key);
    if (match && match[1] !== PROJECT_NAMESPACE && match[1] !== "file") {
      return undefined;
    }
    const file = match ? match[2] : key;
    return path.isAbsolute(file) ? file : path.resolve(this.rootDir, file);
  }

  private erroredInputs(errors: readonly Message[]): string[] {
    return errors.flatMap(e => {
      const file = e.location?.file && this.inputPath(e.location.file);
      return file && this.inProject(file) ? [file] : [];
    });
  }

  /** esbuild's errors as one message, the first few with where they are. */
  private formatErrors(errors: readonly Message[]): string {
    return errors
      .slice(0, 3)
      .map(e => {
        const file = e.location?.file && this.inputPath(e.location.file);
        const where =
          file && e.location
            ? `${path.relative(this.rootDir, file).replace(/\\/g, "/")}:${e.location.line}:${e.location.column + 1}: `
            : "";
        const unresolved = /^Could not resolve "([^"]+)"/.exec(e.text)?.[1];
        const text =
          unresolved && NODE_BUILTINS.has(unresolved.replace(/\/.*$/, ""))
            ? nodeImportMessage(unresolved)
            : e.text;
        return where + text;
      })
      .join("\n");
  }
}
