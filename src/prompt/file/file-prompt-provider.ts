// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { builtinCheck, builtinCheckInfos } from "../../checks/index.ts";
import type { FileProvider } from "../../file-provider.ts";
import { LocalFileProvider } from "../../file-provider-local.ts";
import type { SDKAdapter } from "../../sdk/sdk-adapter.ts";
import { isEditable } from "../../shared/helpers.ts";
import type {
  AddPromptContext,
  CheckInfo,
  ExecutionInput,
  NormalizedPromptUpdates,
  PromptChangeEvent,
  PromptInputSources,
  PromptStyle,
  PropDefinition,
} from "../../shared/types.ts";
import type { PromptSpanInfo } from "../../trace/prompt-tracer.ts";
import {
  collectInputSlots,
  type InputSource,
  matchSourcesToSlots,
  type ResolutionContext,
  resolveExecutionInput,
  resolveExecutionInputs,
} from "../execution-inputs.ts";
import { isResource, type Resource } from "../playground/resource.ts";
import {
  DEFAULT_PLAYGROUND_INCLUDE_PATTERNS,
  type PlaygroundModuleError,
  type RegisteredResource,
  type RegisteredSource,
  ResourceRegistry,
  resourceParameterNames,
} from "../playground/resource-registry.ts";
import {
  type ExecuteOptions,
  type ExecuteResult,
  type PreparedCheck,
  type PromptProvider,
  type PromptRefLike,
  type PromptVariations,
  type PromptVersions,
  type ResolvedPromptInputs,
  toPromptRef,
  type UpdatePromptResult,
} from "../prompt-provider.ts";
import type {
  StoredVariation,
  VariationStore,
} from "../variations/variation-store.ts";
import type { VersioningAdapter } from "../versioning/versioning-adapter.ts";
import { FileVariations } from "./file-variations.ts";
import type {
  FilePromptMetadata,
  NormalizedFilePrompt,
  ParsedFilePrompt,
  ProbeResult,
  ProbeResults,
  PromptFileType,
  SlotMatchRequest,
  TypeProbe,
  TypeProbeRequest,
  TypeResolutionResult,
} from "./prompt-file-type.ts";
import { TSPromptFileType } from "./ts/ts-prompt-file-type.ts";

/** Directories never scanned unless an include pattern names them. */
const DEFAULT_IGNORED_DIRS = ["node_modules", "dist", ".git"];

/**
 * The ignore patterns to scan `includePatterns` with: the user's own
 * `ignorePatterns` plus a `**\/<dir>/**` pattern for each default ignored
 * directory — except those an include pattern names as a path segment (e.g.
 * `dist/**\/*.prompt.ts`), so opting a directory back in is explicit.
 */
function withDefaultIgnores(
  includePatterns: readonly string[],
  ignorePatterns: readonly string[],
): string[] {
  const defaults = DEFAULT_IGNORED_DIRS.filter(
    dir => !includePatterns.some(p => p.split("/").includes(dir)),
  ).map(dir => `**/${dir}/**`);
  return [...defaults, ...ignorePatterns];
}

/** A resource that takes arguments, with the sources that may fill them. */
interface ResourceWithParameters {
  resource: RegisteredResource;
  /** Its schema-valued input names, in declaration order. */
  names: string[];
  /** Sources in scope for its own module, excluding any that depend on it. */
  candidates: RegisteredSource[];
}

/** The resources available while normalizing a batch of prompts. */
interface ResourceView {
  /** Playground modules that failed to load. */
  moduleErrors: PlaygroundModuleError[];
  /** Per prompt, in order, the sources it can draw on. */
  inScope: RegisteredSource[][];
  /** Every resource that takes arguments. */
  withParams: ResourceWithParameters[];
}

/**
 * Configuration options for the {@link FilePromptProvider}.
 */
export interface FilePromptProviderOptions {
  /**
   * Uniquely identifies this provider instance when multiple providers are used together. Defaults to 'fs' + an incrementing number.
   */
  id?: string;

  /**
   * The root directory to scan recursively for prompt files. Defaults to the current working directory.
   */
  rootDir?: string;
  /**
   * Glob patterns to include when scanning for prompt files. Defaults to {@link PromptFileType.defaultIncludePatterns}.
   */
  includePatterns?: readonly string[];
  /**
   * Glob patterns to exclude when scanning for prompt files and playground
   * modules. These are added to the built-in ignores — `node_modules`, `dist`
   * and `.git` directories — rather than replacing them. A built-in ignore is
   * skipped for any directory an include pattern names explicitly, so
   * `includePatterns: ['dist/**\/*.prompt.ts']` still scans `dist`.
   */
  ignorePatterns?: readonly string[];

  /**
   * Optional custom file provider that abstracts file system access, useful for testing or non-local environments. Defaults to an instance of {@link LocalFileProvider}.
   */
  fileProvider?: FileProvider;

  /**
   * Optional custom file type handler that defines how to parse prompt files and manipulate properties. Defaults to an instance of {@link TSPromptFileType}.
   */
  fileType?: PromptFileType;

  /**
   * Glob patterns selecting **playground modules** — code that exists only to
   * exercise a prompt from the playground, and that the application itself
   * must never import. See {@link ResourceRegistry} for what they may export
   * and how their scope is decided.
   *
   * Defaults to `['**\/*.playground.ts', '.evalution/playground/**\/*.ts']`.
   */
  playgroundIncludePatterns?: readonly string[];

  /**
   * SDK adapter that governs prompt structure and execution.
   */
  sdk: SDKAdapter;

  /**
   * How states of the world are named, so a trace records which content of a
   * prompt it ran and an old one can be reopened. See
   * `specs/prompt-versions-and-variations.md`.
   *
   * Defaults, when no {@link fileProvider} is given (so files are on the real
   * disk), to a git adapter when `rootDir` is inside a repository; outside
   * one there are no versions, though variations still work. With a custom
   * `fileProvider` there is no default. `false` turns versions off.
   */
  versioning?: VersioningAdapter | false;

  /**
   * Where variations — edits held apart from the source — are kept. With one,
   * editing a prompt never writes its file: edits collect in a work-in-progress
   * variation until they are explicitly saved.
   *
   * Defaults, when no {@link fileProvider} is given, to a database at
   * `.evalution/variations/variations.db`. With a custom `fileProvider` there
   * is no default. `false` turns variations off, so edits write straight to
   * the file.
   */
  variationStore?: VariationStore | false;
}

let defaultIDCounter = 0;

/**
 * A TypeScript type expression naming what a source produces, for the file
 * type to evaluate in the scope of `promptFilePath`.
 *
 * The type is read back off the resource's own declaration rather than
 * declared separately: it is where the type came from in the first place, so
 * there is nothing to keep in sync, nothing to go stale under a rename, and
 * nothing a checker could not verify. A dynamic resource's type comes off
 * `create()`'s return (`Awaited` covers the common async `create`); a static
 * `value` resource has no `create` to read, so its `value` property is read
 * directly. Which one applies is known from the scan (see
 * {@link RegisteredSource.resource}), and has to be — the two definitions are
 * a union, so indexing the wrong property wouldn't type-check. A value source
 * appends its own key(s) as further indexed access, which is what makes
 * `taskA.id` type-check as `TaskId` rather than as the whole seeded object.
 */
function resourceTypeExpression(
  promptFilePath: string,
  source: RegisteredSource,
): string {
  const resource = source.resource;
  let specifier = path
    .relative(path.dirname(promptFilePath), resource.modulePath)
    .replace(/\\/g, "/")
    .replace(/\.ts$/, ".js");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;

  const module = `typeof import(${JSON.stringify(specifier)})`;
  const exported = `${module}[${JSON.stringify(resource.key)}]`;
  let expression =
    "value" in resource.resource
      ? `${exported}["value"]`
      : `Awaited<ReturnType<${exported}["create"]>>["value"]`;
  for (const key of source.outputPath) {
    expression = `${expression}[${JSON.stringify(key)}]`;
  }
  return expression;
}

/**
 * A type expression naming what `paramName` — a schema-valued entry of
 * `resource`'s own `inputs` — validates to, for the file type to evaluate in
 * the scope of the resource's *own* module.
 *
 * A resource's arguments are prompt-independent, so unlike
 * {@link resourceTypeExpression} this is evaluated once per (resource,
 * parameter) rather than once per (prompt, source): the injected alias lands
 * in the resource's own file, self-referencing its own export, so it needs
 * no import at all. `~standard.types` is Standard Schema's phantom
 * (type-only, never populated at run time) property carrying the schema's
 * inferred input/output types — reading `["output"]` off it is what turns a
 * `z.string()` into the type `string` without this file knowing anything
 * about zod, or any other validator, at all. See
 * `specs/resource-arguments.md` §H.
 */
function resourceParameterTypeExpression(
  resource: Pick<RegisteredResource, "key">,
  paramName: string,
): string {
  // Evaluated in the resource's own file (see `withInjectedTypes`), so the
  // export is already a same-module binding — `typeof <name>` reaches it
  // directly, with no import of the file into itself.
  //
  // `DynamicResourceDefinition.inputs` is declared `inputs?: N` — optional —
  // so `typeof <name>["inputs"]` is `N | undefined`, and indexing a union
  // that includes `undefined` with a key `undefined` doesn't have silently
  // resolves the *whole* expression to `any` rather than to an error.
  // `NonNullable` strips that before the parameter is indexed.
  const inputs = `NonNullable<typeof ${resource.key}["inputs"]>`;
  return (
    `${inputs}[${JSON.stringify(paramName)}] extends ` +
    `{ "~standard": { types?: { output: infer O } } } ? O : never`
  );
}

/**
 * Whether `candidate` depends on `target`, directly or transitively, through
 * *code-wired* `inputs` (dependencies, never arguments — those aren't static).
 *
 * Used to keep a resource off its own argument's source list, and off the
 * list of any resource that would transitively create it — offering it there
 * would let a user assemble in the picker exactly the cycle
 * `ResourceRegistry`'s runtime check exists to reject, just with a worse
 * error. See `specs/resource-arguments.md` §H.
 */
function dependsOn(
  candidate: RegisteredResource,
  target: RegisteredResource,
  byResource: ReadonlyMap<Resource<unknown>, RegisteredResource>,
  seen = new Set<RegisteredResource>(),
): boolean {
  if (candidate === target) return true;
  if (seen.has(candidate)) return false;
  seen.add(candidate);
  const inputs =
    "inputs" in candidate.resource ? (candidate.resource.inputs ?? {}) : {};
  for (const value of Object.values(inputs)) {
    if (!isResource(value)) continue;
    const registered = byResource.get(value);
    if (registered && dependsOn(registered, target, byResource, seen)) {
      return true;
    }
  }
  return false;
}

/**
 * A resource argument reported with the right name but no resolved type —
 * the checker-less degradation `specs/resource-arguments.md` §B and §G both
 * call for. Unlike an opaque *value* source, an argument is always plain
 * data by construction (it's validated by a schema, never a live handle), so
 * this deliberately isn't `kind: 'opaque'` — that would tell `SourceRow` the
 * slot has no editor at all. A generic string editor is offered instead, and
 * `ResourceRegistry`'s own validation (which needs no checker at all) catches
 * a value the real type would have rejected.
 */
function unresolvedParameter(name: string): PropDefinition {
  return {
    name,
    type: { kind: "primitive", syntax: "unknown", base: "string" },
    optional: false,
  };
}

/** Whether a probe resolved to a definition (rather than factories, or nothing). */
function isDefinition(result: ProbeResult): result is PropDefinition {
  return !!result && !Array.isArray(result);
}

/**
 * A file type's slot-match answer (slot path → source uris) turned around into
 * source uri → the slot paths it fits, or `undefined` when there is none.
 */
function invertSlotMatches(
  byPath: Record<string, string[]> | undefined,
): Map<string, Set<string>> | undefined {
  if (!byPath || Object.keys(byPath).length === 0) return undefined;
  const byUri = new Map<string, Set<string>>();
  for (const [slotPath, uris] of Object.entries(byPath)) {
    for (const uri of uris) {
      const set = byUri.get(uri);
      if (set) set.add(slotPath);
      else byUri.set(uri, new Set([slotPath]));
    }
  }
  return byUri;
}

/**
 * `registered` as {@link InputSource}s for `matchSourcesToSlots`, carrying the
 * checker's type matches (see {@link invertSlotMatches}) where it has any.
 */
function toInputSources(
  registered: readonly RegisteredSource[],
  byType: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): InputSource[] {
  return registered.map(r => {
    const fits = byType?.get(r.uri);
    return {
      uri: r.uri,
      key: r.key,
      for: r.for,
      // Only claim a type opinion where the checker actually produced one:
      // a resource the checker could not read must fall through to the name
      // rule rather than silently matching nothing.
      fitsType: fits ? (_type, path) => fits.has(path) : undefined,
    };
  });
}

/**
 * A {@link PromptProvider} that discovers and serves prompts from
 * files on the local file system (or any {@link FileProvider}).
 *
 * Out of the box it scans for `**\/*.prompt.ts` files and parses them with
 * {@link TSPromptFileType}. Pass a {@link FilePromptProviderOptions} to the
 * constructor to customize this behavior. You must specify at least
 * {@link FilePromptProviderOptions.sdk}.
 *
 * @example
 * ```ts
 * const provider = new FilePromptProvider({ rootDir: '/my/project', sdk: new VercelAISDK() });
 * const prompts = await provider.getAllPrompts();
 * ```
 */
export class FilePromptProvider
  implements PromptProvider<NormalizedFilePrompt>
{
  readonly id: string;
  readonly displayName = "File System";
  readonly description = "Create a .prompt.ts file";
  readonly icon =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0014.5 4H8L6.5 2.5h-5z"/></svg>';

  private files: string[] | null = null;
  private rootDir: string;
  private fileType: PromptFileType;
  private fileProvider: FileProvider;
  private includePatterns: readonly string[];
  private ignorePatterns: readonly string[];
  private playgroundIncludePatterns: readonly string[];
  private playgroundIgnorePatterns: readonly string[];
  private sdkAdapter: SDKAdapter;
  private resources: ResourceRegistry;
  /** Tail of the in-flight mutation chain per file (see {@link mutateFile}). */
  private fileMutations = new Map<string, Promise<void>>();

  /** Explicit adapters, `false` for off, `undefined` for the default. */
  private versioningOption: VersioningAdapter | false | undefined;
  private variationStoreOption: VariationStore | false | undefined;
  /** Whether the defaults apply: files are on the real disk. */
  private useDefaultVersioning: boolean;
  /** Versions and variations, set up on first use. */
  private variationsReady?: Promise<FileVariations | undefined>;
  /** Everyone {@link watch}ing, for changes that aren't file events. */
  private listeners = new Set<(event: PromptChangeEvent) => void>();

  /**
   * Versions of this provider's prompts: git commits. Absent when versioning
   * is turned off; a method rejects when the default turns out to be
   * unavailable (outside a repository).
   */
  readonly versions: PromptVersions | undefined;

  /**
   * Variations of this provider's prompts: unsaved edits, and named
   * alternatives. Absent when turned off; a method rejects when the default
   * store turns out to be unavailable.
   */
  readonly variations: PromptVariations | undefined;

  constructor({
    id = "fs" + (defaultIDCounter++ ? defaultIDCounter : ""),
    rootDir = process.cwd(),
    fileProvider,
    fileType,
    includePatterns,
    ignorePatterns = [],
    playgroundIncludePatterns = DEFAULT_PLAYGROUND_INCLUDE_PATTERNS,
    sdk,
    versioning,
    variationStore,
  }: FilePromptProviderOptions) {
    this.useDefaultVersioning = !fileProvider;
    fileProvider ??= new LocalFileProvider();
    this.versioningOption = versioning;
    this.variationStoreOption = variationStore;
    fileType ??= new TSPromptFileType(fileProvider);
    this.id = id;
    this.rootDir = rootDir;
    this.fileProvider = fileProvider;
    this.fileType = fileType;
    this.includePatterns = includePatterns ?? fileType.defaultIncludePatterns;
    this.ignorePatterns = withDefaultIgnores(
      this.includePatterns,
      ignorePatterns,
    );
    this.playgroundIncludePatterns = playgroundIncludePatterns;
    this.playgroundIgnorePatterns = withDefaultIgnores(
      playgroundIncludePatterns,
      ignorePatterns,
    );
    this.sdkAdapter = sdk;
    this.resources = new ResourceRegistry({
      fileProvider,
      rootDir,
      includePatterns: playgroundIncludePatterns,
      ignorePatterns: this.playgroundIgnorePatterns,
    });
    // Whether each is possible is settled by the options; whether it's
    // actually available only once `fileVariations` has looked.
    this.versions = this.versioningPossible
      ? this.deferredVersions()
      : undefined;
    this.variations = this.storePossible
      ? this.deferredVariations()
      : undefined;
  }

  async getAllPrompts(): Promise<NormalizedFilePrompt[]> {
    await this.ensureFiles();
    const prompts = await this.normalizeAll(this.files!);
    const variations = await this.fileVariations();
    return variations ? variations.annotateAll(prompts) : prompts;
  }

  async getPrompt(ref: PromptRefLike): Promise<NormalizedFilePrompt | null> {
    const variations = await this.fileVariations();
    if (variations) return variations.getPrompt(ref);
    const r = toPromptRef(ref);
    // Without versions there is only head.
    if (r.version !== undefined || r.variation !== undefined) return null;
    return this.headPrompt(r.promptId);
  }

  /** The prompt as it is on disk, unannotated. */
  private async headPrompt(id: string): Promise<NormalizedFilePrompt | null> {
    const [filePath, name] = this.parsePromptId(id);
    const prompts = await this.normalizeAll([filePath]).catch(() => []);
    return prompts.find(p => p.name === name) ?? null;
  }

  /**
   * Whether versions can be set up at all: off when turned off, and when a
   * custom file provider left nothing to default to.
   */
  private get versioningPossible(): boolean {
    if (this.versioningOption === false) return false;
    return !!this.versioningOption || this.useDefaultVersioning;
  }

  /** Whether variations can be set up at all, as {@link versioningPossible}. */
  private get storePossible(): boolean {
    return this.variationStoreOption === undefined
      ? this.useDefaultVersioning
      : !!this.variationStoreOption;
  }

  /**
   * This provider's versions and variations, set up on first use — which is
   * where the defaults are decided, since finding a repository takes a `git`
   * call. `undefined` when there are none.
   */
  private fileVariations(): Promise<FileVariations | undefined> {
    if (!this.versioningPossible && !this.storePossible) {
      return Promise.resolve(undefined);
    }
    this.variationsReady ??= this.setUpVariations().catch(err => {
      console.warn("⚠️ prompt versions are unavailable:", err?.message ?? err);
      return undefined;
    });
    return this.variationsReady;
  }

  private async setUpVariations(): Promise<FileVariations | undefined> {
    let store = this.variationStoreOption || undefined;
    if (
      !store &&
      this.variationStoreOption === undefined &&
      this.useDefaultVersioning
    ) {
      // Imported lazily: the database is a native module a runtime-neutral
      // host (the in-browser demo) can't load, and never needs.
      const { LocalVariationStore } = await import(
        "../variations/local-variation-store.ts"
      );
      // Created on the first write, so browsing leaves nothing behind.
      store = new LocalVariationStore(
        path.join(this.rootDir, ".evalution", "variations", "variations.db"),
      );
    }

    let versioning = this.versioningOption || undefined;
    if (
      !versioning &&
      this.versioningOption === undefined &&
      this.useDefaultVersioning
    ) {
      const { GitVersioning } = await import("../versioning/git-versioning.ts");
      versioning = await GitVersioning.detect(this.rootDir);
    }
    if (!versioning && !store) return undefined;

    return new FileVariations(
      {
        rootDir: this.rootDir,
        fileProvider: this.fileProvider,
        fileType: this.fileType,
        parsePromptId: id => this.parsePromptId(id),
        parseAll: async () => {
          await this.ensureFiles();
          return this.normalizeAll(this.files!);
        },
        normalizeWith: (fileType, files, options) =>
          this.normalizeAll(files, fileType, options),
        applyUpdates: (fileType, filePath, promptName, promptId, updates) =>
          this.applyUpdates(fileType, filePath, promptName, promptId, updates),
        mutateFile: (filePath, mutate) => this.mutateFile(filePath, mutate),
        emit: event => this.emit(event),
      },
      versioning,
      store,
    );
  }

  private emit(event: PromptChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** {@link versions}, forwarding to {@link fileVariations} once it's set up. */
  private deferredVersions(): PromptVersions {
    const ready = async () => {
      const variations = await this.fileVariations();
      if (!variations?.versioning) {
        throw new Error("Prompt versions are unavailable");
      }
      return variations.versions;
    };
    return {
      head: async () => (await ready()).head(),
      history: async (promptId, options) =>
        (await ready()).history(promptId, options),
      get: async id => (await ready()).get(id),
    };
  }

  /** {@link variations}, forwarding to {@link fileVariations} once it's set up. */
  private deferredVariations(): PromptVariations {
    const ready = async () => {
      const variations = await this.fileVariations();
      if (!variations?.store)
        throw new Error("Prompt variations are unavailable");
      return variations.variations;
    };
    return {
      get: async id => (await ready()).get(id),
      list: async promptId => (await ready()).list(promptId),
      name: async (id, name) => (await ready()).name(id, name),
      unname: async (promptId, name) => (await ready()).unname(promptId, name),
      rebase: async (id, onto) => (await ready()).rebase(id, onto),
      openOnHead: async (id, options) =>
        (await ready()).openOnHead(id, options),
      openVersionOnHead: async (promptId, version, options) =>
        (await ready()).openVersionOnHead(promptId, version, options),
      save: async id => (await ready()).save(id),
      discard: async id => (await ready()).discard(id),
      resolve: async (id, choices) => (await ready()).resolve(id, choices),
    };
  }

  /**
   * Parse `files` and normalize every prompt in them.
   *
   * Two TypeScript program builds, however many prompts and resources: one to
   * parse, and one that answers every type question normalization asks —
   * execute parameter probes, which resources fit each prompt's slots, and the
   * types and slots of resources' own arguments. Each build brings a fresh
   * checker that re-derives every type the files depend on, so a question
   * asked in a build of its own costs far more than the same question batched.
   */
  private async normalizeAll(
    files: string[],
    fileType: PromptFileType = this.fileType,
    { resolveTypes = true }: { resolveTypes?: boolean } = {},
  ): Promise<NormalizedFilePrompt[]> {
    const playgroundFiles = await this.resources.modulePaths();
    const parsed = await fileType.parsePrompts(files, this.rootDir, {
      companionFiles: playgroundFiles,
    });

    // Fields only: skip the type questions, which cost a program build of
    // their own — most of a read — and are only needed to run the prompt.
    // Project probes are cached per file type, so they stay.
    if (!resolveTypes) {
      const project = await this.resolveProjectProbes();
      return parsed.map(p => ({
        ...this.sdkAdapter.normalizePrompt(p, undefined, project),
        metadata: p.metadata,
      }));
    }

    // Asked once and threaded through: both the shape of an execute parameter
    // and the slots it contributes are derived from the same probes.
    const probes = this.promptProbes(parsed);
    const scope = await this.resourceScope(parsed);

    const executeRequests = this.promptProbeRequests(parsed, probes);
    const parameterRequests = scope
      ? this.resourceParameterRequests(scope.withParams)
      : [];
    const promptSlotRequests = scope
      ? this.promptSlotRequests(parsed, scope.inScope, probes)
      : [];
    const resourceSlotRequests = scope
      ? this.resourceSlotRequests(scope.withParams)
      : [];

    const resolved = await this.resolveTypes(
      [...executeRequests, ...parameterRequests],
      [...promptSlotRequests, ...resourceSlotRequests],
      this.projectProbes(),
      fileType,
    );
    const project = this.projectResults(resolved.project);

    const executeParameters = this.assemblePromptProbes(
      probes,
      resolved.probes?.slice(0, executeRequests.length),
    );
    const inputSources = scope
      ? this.assembleInputSources(parsed, scope, executeParameters, {
          typeMatches: this.assembleTypeMatches(
            parsed,
            resolved.slotMatches?.slice(0, promptSlotRequests.length),
          ),
          resourceParameters: this.assembleResourceParameters(
            scope.withParams,
            resolved.probes?.slice(executeRequests.length),
          ),
          resourceSlotMatches: resolved.slotMatches?.slice(
            promptSlotRequests.length,
          ),
        })
      : parsed.map(() => undefined);

    return parsed.map((p, i) => {
      const normalized = this.sdkAdapter.normalizePrompt(
        p,
        executeParameters[i],
        project,
      );
      return {
        ...normalized,
        metadata: p.metadata,
        ...(inputSources[i] ? { inputSources: inputSources[i] } : {}),
      };
    });
  }

  /**
   * Put every type question to the file type at once, so they share one
   * program build. A list comes back `undefined` when the file type cannot
   * answer that kind of question at all, which callers degrade from rather
   * than reading as "no answer".
   */
  private async resolveTypes(
    probes: TypeProbeRequest[],
    slotMatches: SlotMatchRequest[],
    project?: TypeProbe[],
    fileType: PromptFileType = this.fileType,
  ): Promise<Partial<TypeResolutionResult>> {
    if (fileType.resolveTypes) {
      return fileType.resolveTypes({
        probes,
        slotMatches,
        ...(project?.length && {
          project: { rootDir: this.rootDir, probes: project },
        }),
      });
    }
    return {
      probes: fileType.resolveTypeProbes
        ? await fileType.resolveTypeProbes(probes)
        : undefined,
      slotMatches: fileType.resolveSlotMatches
        ? await fileType.resolveSlotMatches(slotMatches)
        : undefined,
    };
  }

  /**
   * What the SDK wants to know about the project as a whole — the installed
   * SDK's own types — asked in the file type's language.
   */
  private projectProbes(): TypeProbe[] {
    return this.sdkAdapter.getProjectProbes?.(this.fileType.language) ?? [];
  }

  /**
   * The project probes' results, with an `undefined` ("could not evaluate")
   * for every probe the file type didn't answer, so an adapter always sees
   * each probe it asked for.
   */
  private projectResults(resolved: ProbeResults | undefined): ProbeResults {
    return Object.fromEntries(
      this.projectProbes().map(p => [p.name, resolved?.[p.name]]),
    );
  }

  /**
   * Resolve just the project probes — for adapter methods that need them
   * outside a normalization pass, like the model definition. Cheap after the
   * first call: the file type caches them.
   */
  async resolveProjectProbes(): Promise<ProbeResults> {
    const probes = this.projectProbes();
    if (probes.length === 0) return {};
    const resolved = await this.resolveTypes([], [], probes);
    return this.projectResults(resolved.project);
  }

  /**
   * What the SDK says it wants to know about each prompt — chiefly what it
   * needs at run time — one list per prompt.
   *
   * The file type declares the language and the adapter is asked *in* it, so
   * an adapter that cannot write the expression says so by returning nothing
   * rather than emitting a variant per language and hoping.
   */
  private promptProbes(parsed: readonly ParsedFilePrompt[]): TypeProbe[][] {
    const getProbes = this.sdkAdapter.getPromptProbes;
    if (!getProbes) return parsed.map(() => []);
    const language = this.fileType.language;
    return parsed.map(p => getProbes.call(this.sdkAdapter, p, language));
  }

  /**
   * Ask the file type to answer what the SDK asked about each prompt —
   * the second half of the §E negotiation, with this provider as the only
   * place the two meet. Flattened across prompts, in order.
   *
   * A probe is written defensively enough not to need the parse result to
   * decide whether to ask, which is what makes batching them possible.
   */
  private promptProbeRequests(
    parsed: readonly ParsedFilePrompt[],
    perPrompt: readonly TypeProbe[][],
  ): TypeProbeRequest[] {
    return parsed.flatMap((prompt, i) =>
      perPrompt[i].map(probe => ({
        probe,
        filePath: this.absolutePathOf(prompt),
        promptName: prompt.name,
      })),
    );
  }

  /**
   * Split the answers to {@link promptProbeRequests} back into one list per
   * prompt.
   *
   * Without a resolver the adapter still hears about its own probes — as a
   * row of `undefined`s, which it reads as "declared but unresolved" rather
   * than as "no requirement". Degrading to silence here is exactly the bug
   * this machinery exists to prevent.
   */
  private assemblePromptProbes(
    perPrompt: readonly TypeProbe[][],
    resolved: readonly ProbeResult[] | undefined,
  ): (ProbeResult[] | undefined)[] {
    let cursor = 0;
    return perPrompt.map(probes => {
      if (probes.length === 0) return undefined;
      const start = cursor;
      cursor += probes.length;
      return resolved
        ? resolved.slice(start, cursor)
        : probes.map(() => undefined);
    });
  }

  /**
   * The resources each prompt can draw on, or `undefined` when there are no
   * playground resources (nor modules that failed to load) at all.
   */
  private async resourceScope(
    parsed: readonly ParsedFilePrompt[],
  ): Promise<ResourceView | undefined> {
    const all = await this.resources.all();
    const moduleErrors = await this.resources.errors();
    if (all.length === 0 && moduleErrors.length === 0) return undefined;

    const inScope = await Promise.all(
      parsed.map(p => this.resources.inScopeFor(this.absolutePathOf(p))),
    );

    // A resource's arguments are filled from the sources in scope for its
    // *own* module — the same `inScopeFor` query a prompt's own slots use —
    // minus anything that depends on it.
    const byResource = new Map(all.map(r => [r.resource, r] as const));
    const withParams: ResourceWithParameters[] = [];
    for (const resource of all) {
      const names = resourceParameterNames(resource.resource);
      if (names.length === 0) continue;
      const candidates = (
        await this.resources.inScopeFor(resource.modulePath)
      ).filter(s => !dependsOn(s.resource, resource, byResource));
      withParams.push({ resource, names, candidates });
    }

    return { moduleErrors, inScope, withParams };
  }

  /**
   * Work out which resources can fill which of each prompt's input slots.
   *
   * Three strategies, first match wins (see `matchSourcesToSlots`). The type
   * strategy's answers come from the file type, which is where a checker
   * lives; explicit and name matching are decided here, since neither needs
   * one.
   */
  private assembleInputSources(
    parsed: readonly ParsedFilePrompt[],
    scope: ResourceView,
    executeParameters: readonly (ProbeResult[] | undefined)[],
    {
      typeMatches,
      resourceParameters,
      resourceSlotMatches,
    }: {
      typeMatches: readonly (Map<string, Set<string>> | undefined)[];
      resourceParameters: ReadonlyMap<string, PropDefinition[]>;
      resourceSlotMatches: readonly Record<string, string[]>[] | undefined;
    },
  ): PromptInputSources[] {
    // Prompt-independent, so worked out once rather than per prompt below.
    const resourceSlots = this.assembleResourceSlots(
      scope.withParams,
      resourceParameters,
      resourceSlotMatches,
    );

    return parsed.map((prompt, i) => {
      const available = scope.inScope[i];
      const sources = toInputSources(available, typeMatches[i]);

      const functionSlots = matchSourcesToSlots(
        collectInputSlots(prompt.functionParameters),
        sources,
        prompt.name,
      );
      const execDefs = (executeParameters[i] ?? []).filter(isDefinition);
      const executeSlots = matchSourcesToSlots(
        collectInputSlots(execDefs),
        sources,
        prompt.name,
      );

      const describedResources = this.resources
        .describe(available)
        .map(info => {
          const parameters = resourceParameters.get(info.uri);
          return parameters ? { ...info, parameters } : info;
        });

      // Only a root resource (not one of its output values) carries its own
      // argument slots — see `ResourceInfo.parameters`.
      const promptResourceSlots: Record<string, Record<string, string[]>> = {};
      for (const r of available) {
        if (r.outputPath.length > 0) continue;
        const slots = resourceSlots.get(r.uri);
        if (slots && Object.keys(slots).length > 0) {
          promptResourceSlots[r.uri] = slots;
        }
      }

      return {
        resources: [
          ...describedResources,
          // A playground module that threw is reported rather than hidden, so
          // a broken resource reads as broken instead of as absent.
          ...scope.moduleErrors.map(e => ({
            uri: path.relative(this.rootDir, e.modulePath),
            label: path.basename(e.modulePath),
            scope: "run" as const,
            error: e.message,
          })),
        ],
        functionSlots,
        executeSlots,
        ...(Object.keys(promptResourceSlots).length > 0
          ? { resourceSlots: promptResourceSlots }
          : {}),
      };
    });
  }

  /**
   * One probe per declared resource argument, flattened across resources in
   * order.
   *
   * Asked once across every resource rather than once per prompt: a
   * resource's arguments don't depend on which prompt is looking at it. See
   * `specs/resource-arguments.md` §H.
   */
  private resourceParameterRequests(
    withParams: readonly ResourceWithParameters[],
  ): TypeProbeRequest[] {
    return withParams.flatMap(({ resource, names }) =>
      names.map(name => ({
        probe: {
          kind: "type" as const,
          name,
          expression: resourceParameterTypeExpression(resource, name),
        },
        filePath: resource.modulePath,
        // No function or `prompts()` entry named this exists in a playground
        // module, so `$config` never gets substituted — the expression above
        // doesn't use it, and doesn't need to.
        promptName: resource.key,
      })),
    );
  }

  /**
   * The names and — where a checker is available — resolved types of every
   * discovered resource's declared arguments, keyed by the resource's `uri`.
   *
   * Without a checker, the schema-valued keys are still enumerable at
   * runtime — `resourceParameterNames` doesn't need one — so a resource with
   * arguments still reports their names, each with an unresolved type and a
   * plain string editor (see `unresolvedParameter`) rather than being absent. That degradation, and the resolved case
   * both, are what let `ResourceInfo.parameters` (§G) exist at all.
   */
  private assembleResourceParameters(
    withParams: readonly ResourceWithParameters[],
    resolved: readonly ProbeResult[] | undefined,
  ): Map<string, PropDefinition[]> {
    let cursor = 0;
    return new Map(
      withParams.map(({ resource, names }): [string, PropDefinition[]] => {
        const start = cursor;
        cursor += names.length;
        return [
          resource.uri,
          names.map((name, j) => {
            const result = resolved?.[start + j];
            return isDefinition(result) ? result : unresolvedParameter(name);
          }),
        ];
      }),
    );
  }

  /**
   * The §D.2 type strategy: hand the file type a type expression per resource
   * and let its checker decide assignability. Empty when no prompt has a
   * source in scope, so there is nothing to ask.
   *
   * The expression reads the resource's produced type back off its own
   * `create()`, which is where the type came from — so there is no type string
   * on a resource to go stale under a rename, and no second mechanism to read.
   */
  private promptSlotRequests(
    parsed: readonly ParsedFilePrompt[],
    inScope: readonly RegisteredSource[][],
    probes: readonly TypeProbe[][],
  ): SlotMatchRequest[] {
    const requests = parsed.map((prompt, i) => {
      const filePath = this.absolutePathOf(prompt);
      return {
        filePath,
        promptName: prompt.name,
        // Execute parameters are roots too, but their types live in the probe
        // expression rather than in the prompt's signature. A probe that
        // doesn't resolve, or says "no requirement", contributes no slots.
        extraSlots: Object.fromEntries(
          probes[i].flatMap(probe =>
            probe.kind === "type" ? [[probe.name, probe.expression]] : [],
          ),
        ),
        sources: inScope[i].map(r => ({
          key: r.uri,
          expression: resourceTypeExpression(filePath, r),
        })),
      };
    });
    return requests.every(r => r.sources.length === 0) ? [] : requests;
  }

  /**
   * Turn each prompt's answer to {@link promptSlotRequests} (slot path →
   * source uris) around into source uri → the slot paths it fits.
   */
  private assembleTypeMatches(
    parsed: readonly ParsedFilePrompt[],
    matched: readonly Record<string, string[]>[] | undefined,
  ): (Map<string, Set<string>> | undefined)[] {
    return parsed.map((_, i) => invertSlotMatches(matched?.[i]));
  }

  /**
   * Which sources can fill which of each resource's own argument slots — the
   * §H "resourceSlots" half of matching, asked once across every resource
   * (arguments are prompt-independent) against each one's candidates.
   */
  private resourceSlotRequests(
    withParams: readonly ResourceWithParameters[],
  ): SlotMatchRequest[] {
    return withParams.map(({ resource, names, candidates }) => ({
      filePath: resource.modulePath,
      promptName: resource.key,
      sources: candidates.map(s => ({
        key: s.uri,
        expression: resourceTypeExpression(resource.modulePath, s),
      })),
      extraSlots: Object.fromEntries(
        names.map(name => [
          name,
          resourceParameterTypeExpression(resource, name),
        ]),
      ),
    }));
  }

  /**
   * Which sources can fill which of each resource's own argument slots, keyed
   * by the resource's `uri` — by the same three strategies a prompt's own
   * slots use (see {@link assembleInputSources}), with the file type's answers
   * to {@link resourceSlotRequests} as the type strategy.
   */
  private assembleResourceSlots(
    withParams: readonly ResourceWithParameters[],
    parameters: ReadonlyMap<string, PropDefinition[]>,
    matched: readonly Record<string, string[]>[] | undefined,
  ): Map<string, Record<string, string[]>> {
    return new Map(
      withParams.map(
        ({ resource, candidates }, i): [string, Record<string, string[]>] => [
          resource.uri,
          matchSourcesToSlots(
            collectInputSlots(parameters.get(resource.uri) ?? []),
            toInputSources(candidates, invertSlotMatches(matched?.[i])),
            resource.key,
          ),
        ],
      ),
    );
  }

  private absolutePathOf(prompt: ParsedFilePrompt): string {
    return path.join(this.rootDir, prompt.metadata.relativeFilePath);
  }

  /**
   * Runs `mutate` once every earlier mutation of `filePath` has settled.
   *
   * Every edit is a read-modify-write of the whole file — parse it, splice the
   * new value into the spans that parse reported, write it back. Two that
   * overlap (the editor saves faster than a save completes) leave the second
   * reading a file the first is in the middle of writing: a write truncates
   * before it fills, so that read can land on an empty or partial file, whose
   * parse finds no prompt of that name and reports "Prompt not found". Editing
   * one file at a time is enough to keep each edit's read and write adjacent;
   * edits to different files still run concurrently.
   */
  private mutateFile<T>(
    filePath: string,
    mutate: () => Promise<T>,
  ): Promise<T> {
    const previous = this.fileMutations.get(filePath) ?? Promise.resolve();
    // `then(mutate, mutate)`: a failed edit must not stall the ones behind it.
    const result = previous.then(mutate, mutate);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.fileMutations.set(filePath, settled);
    // Drop the entry once the chain drains, so the map doesn't grow with every
    // file ever edited — but only if nothing queued behind this one.
    settled.then(() => {
      if (this.fileMutations.get(filePath) === settled)
        this.fileMutations.delete(filePath);
    });
    return result;
  }

  /**
   * Applies `updates` to the prompt `ref` names.
   *
   * With variations, this never writes the file: the edit lands in the
   * work-in-progress variation for `ref`'s base — created on the first edit,
   * deleted once edits cancel out — and the returned ref names it. Writing the
   * file is {@link PromptVariations.save}. A saved variation is read-only;
   * open it on the working tree to edit it. Without variations, the file is
   * written as the edit arrives.
   */
  async updatePromptProperties(
    ref: PromptRefLike,
    updates: NormalizedPromptUpdates,
  ): Promise<UpdatePromptResult<NormalizedFilePrompt>> {
    const variations = await this.fileVariations();
    if (variations?.store) return variations.update(ref, updates);

    const r = toPromptRef(ref);
    if (r.version !== undefined || r.variation !== undefined) {
      throw new Error("This provider has no variations to edit");
    }
    const promptId = r.promptId;
    const [filePath, promptName] = this.parsePromptId(promptId);
    const prompt = await this.mutateFile(filePath, async () => {
      await this.applyUpdates(
        this.fileType,
        filePath,
        promptName,
        promptId,
        updates,
      );
      // Re-scan and re-parse to get updated prompt
      return (await this.getPrompt(promptId))!;
    });
    return { prompt, ref: { promptId } };
  }

  /**
   * Writes `updates` into a prompt's source through `fileType` — the one
   * implementation of "apply updates to source", used to save to disk and to
   * materialize a variation in an overlay alike.
   */
  private async applyUpdates(
    fileType: PromptFileType,
    filePath: string,
    promptName: string,
    promptId: string,
    updates: NormalizedPromptUpdates,
  ): Promise<void> {
    const parsed = (
      await fileType
        .parsePrompts([filePath], this.rootDir)
        .catch(() => [] as ParsedFilePrompt[])
    ).find(p => p.name === promptName);
    if (!parsed) {
      throw new Error("Prompt not found");
    }

    const { definitions, values } = parsed.extractedProps;
    const rawUpdates = this.sdkAdapter.denormalizeUpdates(updates, values);

    for (const [propertyName, value] of Object.entries(rawUpdates)) {
      const propDef = definitions.find(d => d.name === propertyName);
      const currentValue = values?.[propertyName];

      if (value === null) {
        // null → remove the property
        if (!propDef) throw new Error(`Property '${propertyName}' not found`);
        await fileType.removeProperty(filePath, propDef);
      } else if (!propDef) {
        // unknown key → add as a new property
        await fileType.addProperty(filePath, promptName, propertyName, value);
      } else {
        // existing key → update in place
        if (currentValue && !isEditable(currentValue)) {
          throw new Error(`Property '${propertyName}' is not editable`);
        }
        if (!propDef.valueSpan) {
          throw new Error(
            `Property '${propertyName}' is missing source metadata`,
          );
        }
        await fileType.updateProperty(filePath, propDef, value, promptId);
      }
    }
  }

  async getModelDefinition(style: PromptStyle): Promise<PropDefinition> {
    return this.sdkAdapter.getModelDefinition(
      await this.resolveProjectProbes(),
      style,
    );
  }

  getModelParameters() {
    return this.sdkAdapter.getModelParameters(this.rootDir);
  }

  async resolveInputs(
    _ref: PromptRefLike,
    inputs: {
      functionInputs?: readonly ExecutionInput[];
      executeInputs?: Record<string, ExecutionInput>;
    },
    context?: ResolutionContext,
  ): Promise<ResolvedPromptInputs> {
    // One lease across both halves: a run-scoped resource named by a function
    // input *and* an execute input must be created once, not twice.
    const lease = this.resources.lease();
    const resolveResource = (
      uri: string,
      binding?: Parameters<typeof lease.acquire>[1],
    ) => lease.acquire(uri, binding);
    // More inputs resolved later in the same lease — a check's — see the
    // same row and bindings the run's own did.
    const resolveMore = async (more: Record<string, ExecutionInput>) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(more).map(
            async ([name, input]) =>
              [
                name,
                await resolveExecutionInput(input, resolveResource, context),
              ] as const,
          ),
        ),
      );
    try {
      const { functionParams, executeValues } = await resolveExecutionInputs(
        inputs,
        resolveResource,
        context,
      );
      return {
        functionParams,
        executeValues,
        receipts: lease.receipts(),
        resolveMore,
        prepareCheck: async (uri, args): Promise<PreparedCheck> => {
          const target =
            builtinCheck(uri) ??
            (await this.resources.checks()).find(c => c.uri === uri)?.check;
          if (!target) throw new Error(`Check '${uri}' not found`);
          const resolved = await lease.resolveDeclared(target.inputs, uri, () =>
            resolveMore(args),
          );
          return {
            run: run => target.run(resolved as never, run),
            timeoutMs: target.timeoutMs,
            runsOnError: target.runsOnError,
          };
        },
        release: () => lease.release(),
      };
    } catch (err) {
      // Nothing will run, so nothing should stay alive.
      await lease.release();
      throw err;
    }
  }

  /**
   * The built-in checks, plus every `check()` exported from a playground
   * module, with each one's schema inputs probed for their types the same
   * way a resource's arguments are (`specs/evals.md` §B.4). A module that
   * failed to load is listed with its error rather than hidden.
   */
  async listChecks(): Promise<CheckInfo[]> {
    const registered = await this.resources.checks();
    const moduleErrors = await this.resources.errors();
    // A check whose inputs are declared wrongly is listed with its error,
    // like a module that failed to load, rather than failing the listing.
    const broken: CheckInfo[] = [];
    const withNames = registered.flatMap(c => {
      try {
        return [{ registered: c, names: resourceParameterNames(c.check) }];
      } catch (err) {
        broken.push({
          uri: c.uri,
          label: c.check.label ?? c.key,
          parameters: [],
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    });
    const requests = withNames.flatMap(({ registered: c, names }) =>
      names.map(name => ({
        probe: {
          kind: "type" as const,
          name,
          expression: resourceParameterTypeExpression(c, name),
        },
        filePath: c.modulePath,
        promptName: c.key,
      })),
    );
    const resolved =
      requests.length > 0 ? await this.resolveTypes(requests, []) : {};

    let cursor = 0;
    const user = withNames.map(({ registered: c, names }): CheckInfo => {
      const start = cursor;
      cursor += names.length;
      return {
        uri: c.uri,
        label: c.check.label ?? c.key,
        ...(c.check.group && { group: c.check.group }),
        ...(c.check.description && { description: c.check.description }),
        ...(c.check.runsOnError && { runsOnError: true }),
        parameters: names.map((name, j) => {
          const result = resolved.probes?.[start + j];
          return isDefinition(result) ? result : unresolvedParameter(name);
        }),
      };
    });
    return [
      ...builtinCheckInfos(),
      ...user,
      ...broken,
      ...moduleErrors.map(e => ({
        uri: path.relative(this.rootDir, e.modulePath),
        label: path.basename(e.modulePath),
        parameters: [],
        error: e.message,
      })),
    ];
  }

  /**
   * Runs the prompt `ref` names, on the working tree: a variation is carried
   * onto it first if made elsewhere. The commit checked out is recorded on
   * the trace as the version — when nothing is uncommitted, so the version
   * is what ran — along with the variation, and both are returned.
   */
  async execute(
    ref: PromptRefLike,
    params: any[],
    {
      traceId,
      rootSpanId,
      executeValues,
      inputs,
      onSettled,
    }: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const r = toPromptRef(ref);
    const variations = await this.fileVariations();
    if (!variations && (r.version !== undefined || r.variation !== undefined)) {
      throw new Error("This provider has no versions or variations to run");
    }

    const prepared = variations ? await variations.prepareRun(r) : undefined;
    const variation: StoredVariation | undefined = prepared?.variation;
    // A rebase may have found the prompt under a new id (a rename).
    const promptId = variation?.promptId ?? r.promptId;
    const [filePath, promptName] = this.parsePromptId(promptId);

    const config = variation
      ? await variations!.loadConfig(variation, params)
      : await this.fileType.loadConfig(filePath, promptName, params);
    // Pass the prompt identity so a config that didn't go through the
    // `prompts()` helper still produces a named trace linked back to the
    // prompt. `promptId` is the provider-scoped id the registry resolves on.
    //
    // The trace records the *unresolved* inputs, not `params`: under this
    // design one of those entries may be a live database handle, which would
    // serialize into a span as a useless blob, and the recipe is what a replay
    // actually needs. Alongside them goes a snapshot of the signature they
    // were captured against, and the version (and variation) that ran.
    const snapshot = await this.parameterSnapshot(promptId, variation);
    const version = prepared?.head?.clean
      ? prepared.head.commit?.id
      : undefined;
    const identity: PromptSpanInfo = {
      id: promptId,
      name: promptName,
      functionInputs: inputs?.functionInputs
        ? [...inputs.functionInputs]
        : undefined,
      executeInputs: inputs?.executeInputs,
      parameterDefinitions: snapshot?.functionParameters,
      executeParameterDefinitions: snapshot?.executeParameters,
      version,
      variation: variation?.id,
    };
    const handle = await this.sdkAdapter.executeConfig(config, {
      traceId,
      rootSpanId,
      executeValues,
      identity,
    });

    // An adapter that reports completion drives teardown off the real end of
    // the run; one that doesn't gets teardown now, which is wrong but bounded
    // — better than a resource that is never disposed.
    if (onSettled) {
      if (handle) void handle.done.then(onSettled, onSettled);
      else onSettled();
    }
    return {
      ...(version && { version }),
      ...(variation && { variation: variation.id }),
    };
  }

  /**
   * The prompt's parameter definitions as they stand right now, recorded
   * beside a run's inputs.
   *
   * Redundant whenever the run's recorded version can be read back, but a run
   * on a dirty working tree records no version, and the recorded signature
   * costs little. Replay then compares two known signatures instead
   * of inferring a match.
   *
   * Both halves are recorded: the execute parameters are only known after
   * normalization (their shapes come from type probes), and without them a
   * trace's `executeInputs` would have names but no types.
   */
  private async parameterSnapshot(
    promptId: string,
    variation?: StoredVariation,
  ): Promise<
    | {
        functionParameters: PropDefinition[];
        executeParameters?: PropDefinition[];
      }
    | undefined
  > {
    try {
      const prompt = variation
        ? await (await this.fileVariations())?.preparedPrompt(variation)
        : await this.headPrompt(promptId);
      return prompt
        ? {
            functionParameters: prompt.functionParameters,
            executeParameters: prompt.executeParameters,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async setupTraceIngestion() {
    return this.sdkAdapter.setupTraceIngestion?.();
  }

  async renamePrompt(
    promptId: string,
    newName: string,
  ): Promise<NormalizedFilePrompt> {
    const [filePath, oldName] = this.parsePromptId(promptId);
    const renamed = await this.mutateFile(filePath, async () => {
      await this.fileType.renamePrompt(filePath, oldName, newName);
      const relFilePath = path.relative(this.rootDir, filePath);
      return `${relFilePath}#${newName}`;
    });
    // Unsaved edits follow the prompt to its new name.
    await (await this.fileVariations())?.onPromptRenamed(promptId, renamed);
    const prompt = await this.getPrompt(renamed);
    if (!prompt) throw new Error("Failed to find renamed prompt");
    return prompt;
  }

  async addPrompt(
    partial: Partial<NormalizedFilePrompt>,
  ): Promise<NormalizedFilePrompt | AddPromptContext> {
    const relFilePath = (partial.metadata as FilePromptMetadata | undefined)
      ?.relativeFilePath;

    if (relFilePath) {
      const normalizedRelFilePath = path.extname(relFilePath)
        ? relFilePath
        : relFilePath + this.fileType.defaultFileExtension;
      const absPath = path.join(this.rootDir, normalizedRelFilePath);
      const baseName = path.basename(normalizedRelFilePath);
      const firstDot = baseName.indexOf(".");
      const promptsId = firstDot >= 0 ? baseName.slice(0, firstDot) : baseName;
      const name = partial.name ?? promptsId;

      const content = this.fileType.newPromptSkeleton(
        promptsId,
        name,
        this.sdkAdapter.promptsHelperImport,
      );

      await this.fileProvider.writeFile(absPath, content);
      if (this.files && !this.files.includes(absPath)) {
        this.files.push(absPath);
      }

      const prompt = await this.getPrompt(`${normalizedRelFilePath}#${name}`);
      if (!prompt) throw new Error("Failed to create prompt");
      return prompt;
    }

    // Need more info — return form fields
    const directories = await this.listDirectories();
    const prompts = await this.getAllPrompts();
    const dirCounts = new Map<string, number>();
    for (const p of prompts) {
      const dir = path.dirname(p.metadata.relativeFilePath);
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    let defaultDir = ".";
    let maxCount = 0;
    for (const [dir, count] of dirCounts) {
      if (count > maxCount && directories.includes(dir)) {
        defaultDir = dir;
        maxCount = count;
      }
    }

    return {
      fields: [
        {
          name: "directory",
          label: "Directory",
          type: "select" as const,
          required: true,
          defaultValue: defaultDir,
          options: directories.map(d => ({
            label: d === "." ? "(root)" : d,
            value: d,
          })),
        },
        {
          name: "fileName",
          label: "File name",
          type: "text" as const,
          required: true,
          placeholder: `my-prompt (or my-prompt${this.fileType.defaultFileExtension})`,
        },
        {
          name: "name",
          label: "Prompt name",
          type: "text" as const,
          required: false,
          placeholder: "Default: file name without extension",
        },
      ],
    };
  }

  watch(callback: (event: PromptChangeEvent) => void): () => void {
    // Changes that aren't file events — a WIP edited, saved or rebased —
    // reach watchers through this.
    this.listeners.add(callback);

    const unwatchPlayground = this.fileProvider.watch(
      this.playgroundIncludePatterns,
      { cwd: this.rootDir, ignored: this.playgroundIgnorePatterns },
      async () => {
        // Prompts' resolved types depend on playground modules.
        (await this.fileVariations())?.invalidate();
        // A changed playground module invalidates every prompt that could be
        // offered its resources, and the change stream is keyed by prompt id —
        // so it has to fan out. Server-scoped instances created by the old
        // code are disposed first: they must not outlive it.
        await this.resources.invalidate();
        try {
          for (const prompt of await this.getAllPrompts()) {
            callback({ type: "change", promptId: prompt.id });
          }
        } catch (err) {
          console.warn(
            "failed to refresh prompts after a playground change:",
            err,
          );
        }
      },
    );

    const unwatchPrompts = this.fileProvider.watch(
      this.includePatterns,
      { cwd: this.rootDir, ignored: this.ignorePatterns },
      async (eventType, filePath) => {
        const absolutePath = this.resolveFilePath(filePath);
        // Note: events for this provider's own writes are NOT filtered here;
        // clients dedupe their own edits' echoes (see client/self-edits.ts) so
        // that multiple clients sharing one workspace all stay in sync.
        if (eventType === "change" || eventType === "add") {
          if (this.files && !this.files.includes(absolutePath)) {
            this.files.push(absolutePath);
          }
          const prompts = await this.fileType.parsePrompts(
            [absolutePath],
            this.rootDir,
          );
          prompts.forEach(prompt => {
            callback({
              type: eventType === "change" ? "change" : "add",
              promptId: prompt.id,
            });
          });
          // An edit made outside the playground moves head under any unsaved
          // edits to these prompts: rebase them onto it.
          const variations = await this.fileVariations();
          await variations
            ?.onPromptsChanged(prompts.map(p => p.id))
            .catch(err => console.warn("failed to rebase unsaved edits:", err));
        } else {
          (await this.fileVariations())?.invalidate();
          if (this.files) {
            this.files = this.files.filter(f => f !== absolutePath);
          }
          // filePath is relative to rootDir (chokidar cwd)
          callback({ type: "remove", promptId: filePath });
        }
      },
    );

    return () => {
      this.listeners.delete(callback);
      unwatchPlayground();
      unwatchPrompts();
    };
  }

  private async ensureFiles(): Promise<void> {
    if (!this.files) {
      this.files = await Array.fromAsync(this.findPromptFiles());
    }
  }

  private async *findPromptFiles(): AsyncIterableIterator<string> {
    const uniqueFiles = new Set<string>();

    for (const pattern of this.includePatterns) {
      const iter = this.fileProvider.glob(pattern, {
        cwd: this.rootDir,
        absolute: true,
        ignore: this.ignorePatterns,
      });
      for await (const file of iter) {
        if (!uniqueFiles.has(file)) {
          uniqueFiles.add(file);
          yield file;
        }
      }
    }
  }

  private parsePromptId(id: string): [string, string] {
    const hashIdx = id.lastIndexOf("#");
    if (hashIdx < 0) {
      throw new Error(`Invalid prompt ID format: ${id}`);
    }
    const relativePath = id.slice(0, hashIdx);
    const functionName = id.slice(hashIdx + 1);
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(this.rootDir, relativePath);
    return [absolutePath, functionName];
  }

  private async listDirectories(): Promise<string[]> {
    const dirs = new Set<string>(["."]);
    const iter = this.fileProvider.glob("**/", {
      cwd: this.rootDir,
      ignore: this.ignorePatterns,
    });
    for await (const dir of iter) {
      // glob yields trailing-slash paths like "src/prompts/"
      const clean = dir.replace(/\/$/, "");
      if (clean) dirs.add(clean);
    }
    return Array.from(dirs).sort();
  }

  private resolveFilePath(relativePath: string): string {
    if (relativePath.startsWith("/")) {
      return relativePath;
    }
    return `${this.rootDir}/${relativePath}`;
  }
}
