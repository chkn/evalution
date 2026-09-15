// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { FileProvider } from "../../file-provider.ts";
import { LocalFileProvider } from "../../file-provider-local.ts";
import type { SDKAdapter } from "../../sdk/sdk-adapter.ts";
import { isEditable } from "../../shared/helpers.ts";
import type {
  AddPromptContext,
  ExecutionInput,
  NormalizedPromptUpdates,
  PromptChangeEvent,
  PromptInputSources,
  PropDefinition,
} from "../../shared/types.ts";
import {
  collectInputSlots,
  type InputSource,
  matchSourcesToSlots,
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
import type {
  ExecuteOptions,
  PromptProvider,
  ResolvedPromptInputs,
} from "../prompt-provider.ts";
import type {
  FilePromptMetadata,
  NormalizedFilePrompt,
  ParsedFilePrompt,
  PromptFileType,
  SlotMatchRequest,
  TypeProbe,
  TypeProbeRequest,
  TypeResolutionResult,
} from "./prompt-file-type.ts";
import { TSPromptFileType } from "./ts/ts-prompt-file-type.ts";

const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
];

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
   * Glob patterns to exclude when scanning for prompt files. Defaults to ['\*\*\/node_modules/\*\*', '\*\*\/dist/\*\*', '\*\*\/.git/**'].
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
  resource: RegisteredResource,
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
  private sdkAdapter: SDKAdapter;
  private resources: ResourceRegistry;

  constructor({
    id = "fs" + (defaultIDCounter++ ? defaultIDCounter : ""),
    rootDir = process.cwd(),
    fileProvider = new LocalFileProvider(),
    fileType,
    includePatterns,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    playgroundIncludePatterns = DEFAULT_PLAYGROUND_INCLUDE_PATTERNS,
    sdk,
  }: FilePromptProviderOptions) {
    fileType ??= new TSPromptFileType(fileProvider);
    this.id = id;
    this.rootDir = rootDir;
    this.fileProvider = fileProvider;
    this.fileType = fileType;
    this.includePatterns = includePatterns ?? fileType.defaultIncludePatterns;
    this.ignorePatterns = ignorePatterns;
    this.playgroundIncludePatterns = playgroundIncludePatterns;
    this.sdkAdapter = sdk;
    this.resources = new ResourceRegistry({
      fileProvider,
      rootDir,
      includePatterns: playgroundIncludePatterns,
      ignorePatterns,
    });
  }

  async getAllPrompts(): Promise<NormalizedFilePrompt[]> {
    await this.ensureFiles();
    return this.normalizeAll(this.files!);
  }

  async getPrompt(id: string): Promise<NormalizedFilePrompt | null> {
    const [filePath, name] = this.parsePromptId(id);
    const prompts = await this.normalizeAll([filePath]).catch(() => []);
    return prompts.find(p => p.name === name) ?? null;
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
  private async normalizeAll(files: string[]): Promise<NormalizedFilePrompt[]> {
    const playgroundFiles = await this.resources.modulePaths();
    const parsed = await this.fileType.parsePrompts(files, this.rootDir, {
      companionFiles: playgroundFiles,
    });

    // Asked once and threaded through: both the shape of an execute parameter
    // and the slots it contributes are derived from the same probes.
    const probes = this.executeParameterProbes(parsed);
    const scope = await this.resourceScope(parsed);

    const executeRequests = this.executeParameterRequests(parsed, probes);
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
    );

    const executeParameters = this.assembleExecuteParameters(
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
  ): Promise<Partial<TypeResolutionResult>> {
    const fileType = this.fileType;
    if (fileType.resolveTypes) {
      return fileType.resolveTypes({ probes, slotMatches });
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
   * What the SDK says each prompt needs at run time, one list per prompt.
   *
   * The file type declares the language and the adapter is asked *in* it, so
   * an adapter that cannot write the expression says so by returning nothing
   * rather than emitting a variant per language and hoping.
   */
  private executeParameterProbes(
    parsed: readonly ParsedFilePrompt[],
  ): TypeProbe[][] {
    const getProbes = this.sdkAdapter.getExecuteParameterProbes;
    if (!getProbes) return parsed.map(() => []);
    const language = this.fileType.language;
    return parsed.map(p => getProbes.call(this.sdkAdapter, p, language));
  }

  /**
   * Ask the file type to work out the shape of what the SDK said it needs —
   * the second half of the §E negotiation, with this provider as the only
   * place the two meet. Flattened across prompts, in order.
   *
   * A probe is written defensively enough not to need the parse result to
   * decide whether to ask, which is what makes batching them possible.
   */
  private executeParameterRequests(
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
   * Split the answers to {@link executeParameterRequests} back into one list
   * per prompt.
   *
   * Without a resolver the adapter still hears about its own probes — as a
   * row of `undefined`s, which it reads as "declared but unresolved" rather
   * than as "no requirement". Degrading to silence here is exactly the bug
   * this machinery exists to prevent.
   */
  private assembleExecuteParameters(
    perPrompt: readonly TypeProbe[][],
    resolved: readonly (PropDefinition | null | undefined)[] | undefined,
  ): ((PropDefinition | null | undefined)[] | undefined)[] {
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
    executeParameters: readonly (
      | (PropDefinition | null | undefined)[]
      | undefined
    )[],
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
      const execDefs = (executeParameters[i] ?? []).filter(
        (d): d is PropDefinition => !!d,
      );
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
    resolved: readonly (PropDefinition | null | undefined)[] | undefined,
  ): Map<string, PropDefinition[]> {
    let cursor = 0;
    return new Map(
      withParams.map(({ resource, names }): [string, PropDefinition[]] => {
        const start = cursor;
        cursor += names.length;
        return [
          resource.uri,
          names.map(
            (name, j) => resolved?.[start + j] ?? unresolvedParameter(name),
          ),
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
          probes[i].map(probe => [probe.name, probe.expression]),
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

  async updatePromptProperties(
    promptId: string,
    updates: NormalizedPromptUpdates,
  ): Promise<NormalizedFilePrompt> {
    const [filePath, promptName] = this.parsePromptId(promptId);
    const parsed = (
      await this.fileType
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
        await this.fileType.removeProperty(filePath, propDef);
      } else if (!propDef) {
        // unknown key → add as a new property
        await this.fileType.addProperty(
          filePath,
          promptName,
          propertyName,
          value,
        );
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
        await this.fileType.updateProperty(filePath, propDef, value, promptId);
      }
    }

    // Re-scan and re-parse to get updated prompt
    return (await this.getPrompt(promptId))!;
  }

  getModelCatalog() {
    return this.sdkAdapter.getModelCatalog();
  }

  getModelParameters() {
    return this.sdkAdapter.getModelParameters(this.rootDir);
  }

  async resolveInputs(
    _promptId: string,
    inputs: {
      functionInputs?: readonly ExecutionInput[];
      executeInputs?: Record<string, ExecutionInput>;
    },
  ): Promise<ResolvedPromptInputs> {
    // One lease across both halves: a run-scoped resource named by a function
    // input *and* an execute input must be created once, not twice.
    const lease = this.resources.lease();
    try {
      const { functionParams, executeValues } = await resolveExecutionInputs(
        inputs,
        (uri, binding) => lease.acquire(uri, binding),
      );
      return {
        functionParams,
        executeValues,
        receipts: lease.receipts(),
        release: () => lease.release(),
      };
    } catch (err) {
      // Nothing will run, so nothing should stay alive.
      await lease.release();
      throw err;
    }
  }

  async execute(
    promptId: string,
    params: any[],
    { traceId, executeValues, inputs, onSettled }: ExecuteOptions = {},
  ): Promise<void> {
    const [filePath, promptName] = this.parsePromptId(promptId);
    const config = await this.fileType.loadConfig(filePath, promptName, params);
    // Pass the prompt identity so a config that didn't go through the
    // `prompts()` helper still produces a named trace linked back to the
    // prompt. `promptId` is the provider-scoped id the registry resolves on.
    //
    // The trace records the *unresolved* inputs, not `params`: under this
    // design one of those entries may be a live database handle, which would
    // serialize into a span as a useless blob, and the recipe is what a replay
    // actually needs. Alongside them goes a snapshot of the signature they
    // were captured against, so a later replay can diff two known shapes
    // rather than guess whether they still line up.
    const handle = await this.sdkAdapter.executeConfig(config, {
      traceId,
      executeValues,
      identity: {
        id: promptId,
        name: promptName,
        functionInputs: inputs?.functionInputs
          ? [...inputs.functionInputs]
          : undefined,
        executeInputs: inputs?.executeInputs,
        parameterDefinitions: await this.parameterSnapshot(
          filePath,
          promptName,
        ),
      },
    });

    // An adapter that reports completion drives teardown off the real end of
    // the run; one that doesn't gets teardown now, which is wrong but bounded
    // — better than a resource that is never disposed.
    if (onSettled) {
      if (handle) void handle.done.then(onSettled, onSettled);
      else onSettled();
    }
  }

  /**
   * The prompt's parameter definitions as they stand right now, recorded
   * beside a run's inputs.
   *
   * For a file-based prompt, git is the version — the playground has no
   * business checking out old commits to replay one — so the cheap equivalent
   * is to write the shape down at run time. Replay then compares two known
   * signatures instead of inferring a match, which works with no version store
   * at all.
   */
  private async parameterSnapshot(
    filePath: string,
    promptName: string,
  ): Promise<PropDefinition[] | undefined> {
    try {
      const parsed = await this.fileType.parsePrompts([filePath], this.rootDir);
      return parsed.find(p => p.name === promptName)?.functionParameters;
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
    await this.fileType.renamePrompt(filePath, oldName, newName);

    const relFilePath = path.relative(this.rootDir, filePath);
    const prompt = await this.getPrompt(`${relFilePath}#${newName}`);
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
    const unwatchPlayground = this.fileProvider.watch(
      this.playgroundIncludePatterns,
      { cwd: this.rootDir, ignored: this.ignorePatterns },
      async () => {
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
        } else {
          if (this.files) {
            this.files = this.files.filter(f => f !== absolutePath);
          }
          // filePath is relative to rootDir (chokidar cwd)
          callback({ type: "remove", promptId: filePath });
        }
      },
    );

    return () => {
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
