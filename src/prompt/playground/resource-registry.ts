// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FileProvider } from "../../file-provider.ts";
import type { ResourceInfo, ResourceScope } from "../../shared/types.ts";
import {
  isResource,
  isStandardSchema,
  type Resource,
  type ResourceInputs,
  type ResourceOutputDefinition,
} from "./resource.ts";

/** Default patterns matching playground modules. See {@link ResourceRegistry}. */
export const DEFAULT_PLAYGROUND_INCLUDE_PATTERNS = [
  "**/*.playground.ts",
  ".evalution/playground/**/*.ts",
];

/** One discovered resource, with everything needed to resolve and describe it. */
export interface RegisteredResource {
  /** `<module path relative to rootDir>#<export name>`. */
  uri: string;
  /** The export name within its module — the resource's key for name matching. */
  key: string;
  /** Absolute path of the playground module that exported it. */
  modulePath: string;
  /**
   * The directory a `*.playground.ts` module scopes its resources to, or
   * `undefined` for a project-scoped module under `.evalution/playground/`.
   */
  scopeDir?: string;
  /** The `resource()` object itself. */
  resource: Resource<unknown>;
}

/** A playground module that could not be loaded. */
export interface PlaygroundModuleError {
  /** Absolute path of the module that failed. */
  modulePath: string;
  /** The import-time failure, as a message. */
  message: string;
}

/** A live instance of a resource, plus how to tear it down. */
interface Instance {
  value: unknown;
  receipt?: unknown;
  dispose?: () => void | Promise<void>;
  reset?: () => void | Promise<void>;
}

/** A resource's declared `inputs`, split into its two kinds of entry. See `specs/resource-arguments.md` §B. */
interface PartitionedInputs {
  /** Resource-valued entries: code-wired dependencies, resolved by identity. */
  deps: [string, Resource<unknown>][];
  /** Schema-valued entries: arguments, resolved per run and validated. */
  params: [string, StandardSchemaV1][];
}

/** What an invalid `inputs` entry's value looks like, for the error message. */
function describeInvalidInput(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return type === "object" ? "a plain object" : `a ${type}`;
}

/**
 * Splits `target`'s `inputs` (if any) into dependencies and arguments.
 *
 * Every entry must be a {@link Resource} or a Standard Schema — anything else
 * (a plain value the author meant to wrap, a typo'd import) is an authoring
 * mistake that would otherwise silently vanish from both `deps` and `params`,
 * so `create()` runs with the entry simply missing rather than an error
 * pointing at it.
 */
function partitionInputs(target: Resource<unknown>): PartitionedInputs {
  const inputs: ResourceInputs =
    "inputs" in target ? (target.inputs ?? {}) : {};
  const deps: [string, Resource<unknown>][] = [];
  const params: [string, StandardSchemaV1][] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (isResource(value)) deps.push([name, value]);
    else if (isStandardSchema(value)) params.push([name, value]);
    else {
      const label = target.label ?? "resource";
      throw new Error(
        `Resource '${label}': input '${name}' must be another resource or a ` +
          `Standard Schema (https://standardschema.dev), not ${describeInvalidInput(value)}.`,
      );
    }
  }
  return { deps, params };
}

/**
 * The names of `target`'s declared arguments — its schema-valued `inputs`
 * entries — in declaration order. Empty when it takes none.
 *
 * The provider layer (which is where a checker lives, if one is available)
 * uses this to know which parameters to probe or, lacking a checker, to
 * report with an unresolved type — see `specs/resource-arguments.md` §G, §H.
 */
export function resourceParameterNames(target: Resource<unknown>): string[] {
  return partitionInputs(target).params.map(([name]) => name);
}

/** Why a `scope: 'server'` resource that declares arguments is rejected. See `specs/resource-arguments.md` §D. */
function serverScopedArgumentsError(label: string): string {
  return (
    `Resource '${label}' is server-scoped and declares arguments — a ` +
    `server-scoped resource may not take arguments (specs/resource-arguments.md §D).`
  );
}

/**
 * One selectable input source: a resource, or one named value read off one.
 *
 * The registry's map is `uri → RegisteredResource`, one entry per
 * `resource()` export; a `RegisteredSource` is a new leaf on the same data —
 * the resource itself (`outputPath: []`), or one of its declared
 * {@link ResourceOutputDefinition} entries. Every consumer (`describe`,
 * `inScopeFor`, matching, `lease.acquire`) wants this flat form rather than a
 * nested one. See `specs/resource-hierarchy.md` §C.
 */
export interface RegisteredSource {
  /** `<module>#<export>` or `<module>#<export>.<value key>`. */
  uri: string;
  /** The name the source is matched by: the export name, or the value's key. */
  key: string;
  /** Display label — the resource's, or the value's. */
  label: string;
  /** Group path segments, from `group`. Empty for a top-level source. */
  group: readonly string[];
  /** Explicit slot targeting, from the resource's or the value's `for`. */
  for?: string | readonly string[];
  /** The registration whose `create()` produces this. Its own, for a root source. */
  resource: RegisteredResource;
  /** Path read off the produced value. Empty for a root source. */
  outputPath: readonly string[];
}

/** `"Tasks/Regressions"` → `["Tasks", "Regressions"]`, trimmed and with empty segments dropped. */
function parseGroupPath(group: string | undefined): string[] {
  if (!group) return [];
  return group
    .split("/")
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

/** Every {@link RegisteredSource} — the resource itself, plus one per declared output — for one registration. */
function sourcesFor(registered: RegisteredResource): RegisteredSource[] {
  const { resource, uri, key } = registered;
  const group = parseGroupPath(resource.group);
  const root: RegisteredSource = {
    uri,
    key,
    label: resource.label ?? key,
    group,
    for: resource.for,
    resource: registered,
    outputPath: [],
  };

  const outputs = Object.entries(resource.outputs ?? {}) as [
    string,
    string | ResourceOutputDefinition | undefined,
  ][];
  const outputSources = outputs
    .filter(
      (entry): entry is [string, string | ResourceOutputDefinition] =>
        entry[1] !== undefined,
    )
    .map(([outputKey, def]): RegisteredSource => {
      const outputDef: ResourceOutputDefinition =
        typeof def === "string" ? { label: def } : def;
      return {
        uri: `${uri}.${outputKey}`,
        key: outputKey,
        label: outputDef.label ?? outputKey,
        group,
        for: outputDef.for,
        resource: registered,
        outputPath: [outputKey],
      };
    });

  return [root, ...outputSources];
}

/** Splits a source `uri` into the registered resource's own `uri` and the value path within it. */
function parseSourceUri(uri: string): {
  rootUri: string;
  outputPath: readonly string[];
} {
  const hashIdx = uri.indexOf("#");
  if (hashIdx < 0) return { rootUri: uri, outputPath: [] };
  const exportAndValue = uri.slice(hashIdx + 1);
  const dotIdx = exportAndValue.indexOf(".");
  if (dotIdx < 0) return { rootUri: uri, outputPath: [] };
  return {
    rootUri: uri.slice(0, hashIdx + 1) + exportAndValue.slice(0, dotIdx),
    outputPath: [exportAndValue.slice(dotIdx + 1)],
  };
}

/** Reads `path` off `value`, reporting whether it actually existed there. */
function readOutputPath(
  value: unknown,
  path: readonly string[],
): { found: true; value: unknown } | { found: false } {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object" || !(key in cursor)) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return { found: true, value: cursor };
}

/**
 * A resource's scope when it names none explicitly. A static `value`
 * resource has nothing to create per run — it defaults to `'server'` rather
 * than `'run'`, since it's already the same value for the life of the
 * process. Kept as one function so every place that needs the default (
 * instantiation, dependency-lifetime checks, and the panel's description)
 * agrees with it.
 */
function defaultScope(target: Resource<unknown>): ResourceScope {
  return "value" in target ? "server" : "run";
}

/**
 * Whether `value` is built entirely from plain JSON data — primitives, plain
 * objects, and arrays, recursively, with no `undefined`, function, symbol,
 * `bigint`, class instance, or cycle.
 *
 * This is what decides whether {@link ResourceRegistry.describe} ships a
 * resource's value to the panel: a live handle (a `Db`, a class-backed
 * client) fails here even though `JSON.stringify` would happily — if
 * misleadingly — turn it into `{}`, silently dropping the methods that made
 * it a handle in the first place. Only a value this function accepts is safe
 * to hand to the panel's own editor as a preview.
 */
function isPlainSerializable(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint.
      return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every(v => isPlainSerializable(v, seen));
  }
  // Excludes class instances (a `Db` handle, a `Date`, a `Map`) — only a
  // literal `{}` or one created with `Object.create(null)` qualifies.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every(v => isPlainSerializable(v, seen));
}

/**
 * A resource reference's arguments, as the lease sees them.
 *
 * Built by `resolveExecutionInput` from an `ExecutionInput`'s `args` — the
 * layer that knows how to turn one into a value — so the registry never has
 * to know `ExecutionInput` exists. See `specs/resource-arguments.md` §D.
 */
export interface ResourceBinding {
  /**
   * Canonical key for these arguments — identity for memoization. The stable
   * JSON encoding of the *unresolved* arguments (object keys sorted, absent
   * and `{}` both encoding to `""`), so a resolved argument that happens to
   * be a live handle never has to be compared or hashed.
   */
  key: string;
  /**
   * Resolves the arguments, keyed by parameter name. Called at most once per
   * (resource, key), lazily — a binding that turns out to hit the memo must
   * not evaluate its arguments at all, and a failed `create` must not have
   * side effects from arguments no one asked for.
   */
  resolve(): Promise<Record<string, unknown>>;
  /** A past run's receipt, on a replay. Passed to `create`; never part of {@link key}. */
  receipt?: unknown;
}

/**
 * The `ResourceLease.receipts()` key for a source acquired with argument key
 * `key`: `<uri>@<key>` when `key` is non-empty (the resource took
 * arguments), or bare `<uri>` when it's `""` (it didn't) — so an existing
 * unparameterized receipt's key is byte-identical to before arguments
 * existed. Exported so `stampReceipts` (`execution-inputs.ts`) can compute
 * the same key from the unresolved recipe when recording a fresh run's
 * receipts onto its inputs. See `specs/resource-arguments.md` §D, §K.
 */
export function receiptKeyOf(uri: string, key: string): string {
  return key ? `${uri}@${key}` : uri;
}

/**
 * A minimal FIFO mutex: `acquire()` resolves with a `release` function once
 * this caller's turn comes, in the order callers asked.
 */
class Mutex {
  private locked = false;
  private waiters: (() => void)[] = [];

  acquire(): Promise<() => void> {
    const release = () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(release);
    }
    return new Promise<() => void>(resolve => {
      this.waiters.push(() => resolve(release));
    });
  }
}

/**
 * Serializes concurrent leases' first use of a `reset`-declaring server-scoped
 * instance, one {@link Mutex} per (resource, argument key). See
 * `specs/resource-arguments.md` §F.
 */
class ResetLockRegistry {
  private mutexes = new Map<Resource<unknown>, Map<string, Mutex>>();

  forLease(): LeaseResetLocks {
    return new LeaseResetLocks(this);
  }

  /** The mutex for (resource, key), created on first use. */
  mutex(target: Resource<unknown>, key: string): Mutex {
    let byKey = this.mutexes.get(target);
    if (!byKey) {
      byKey = new Map();
      this.mutexes.set(target, byKey);
    }
    let mutex = byKey.get(key);
    if (!mutex) {
      mutex = new Mutex();
      byKey.set(key, mutex);
    }
    return mutex;
  }
}

/**
 * One lease's held reset locks.
 *
 * Held in ascending sort-key order for as long as the lease holds any: when a
 * newly needed lock would sort *before* one already held, every held lock is
 * released and the full set (previously held, plus the new one) is
 * reacquired together in order. A lease therefore never holds locks out of
 * order, which is what keeps two leases from taking two locks in opposite
 * orders and deadlocking (`specs/resource-arguments.md` §F).
 */
class LeaseResetLocks {
  private held: {
    sortKey: string;
    target: Resource<unknown>;
    key: string;
    release: () => void;
  }[] = [];
  private entered = new Map<Resource<unknown>, Set<string>>();
  private readonly registry: ResetLockRegistry;

  constructor(registry: ResetLockRegistry) {
    this.registry = registry;
  }

  private hasEntered(target: Resource<unknown>, key: string): boolean {
    return this.entered.get(target)?.has(key) ?? false;
  }

  private markEntered(target: Resource<unknown>, key: string): void {
    let set = this.entered.get(target);
    if (!set) {
      set = new Set();
      this.entered.set(target, set);
    }
    set.add(key);
  }

  /**
   * Locks (resource, key) for this lease's lifetime, if not already locked by
   * it. Returns whether this call is the one that newly entered it — the
   * caller's cue to actually run `reset()`.
   */
  async enter(
    target: Resource<unknown>,
    key: string,
    sortKey: string,
  ): Promise<boolean> {
    if (this.hasEntered(target, key)) return false;

    const maxHeld = this.held.at(-1)?.sortKey;
    if (maxHeld !== undefined && sortKey < maxHeld) {
      const wanted = [
        ...this.held.map(h => ({
          sortKey: h.sortKey,
          target: h.target,
          key: h.key,
        })),
        { sortKey, target, key },
      ].sort((a, b) =>
        a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
      );
      for (const h of this.held) h.release();
      this.held = [];
      for (const w of wanted) {
        const release = await this.registry.mutex(w.target, w.key).acquire();
        this.held.push({ ...w, release });
      }
    } else {
      const release = await this.registry.mutex(target, key).acquire();
      this.held.push({ sortKey, target, key, release });
    }

    this.markEntered(target, key);
    return true;
  }

  releaseAll(): void {
    for (const h of this.held) h.release();
    this.held = [];
  }
}

/** Resources already warned about a `reset` that will never run, so the message appears once each. */
const warnedRunScopedReset = new WeakSet<Resource<unknown>>();

/** One link in a resource's dependency chain, for cycle detection and error messages. */
interface ChainLink {
  resource: Resource<unknown>;
  label: string;
}

/**
 * Carries the dependency chain across `create()`'s `await binding.resolve()`
 * — the point where resolution leaves the registry's own call stack and
 * re-enters it through `ResourceLease.acquire`, a public entry point that
 * otherwise has no way to know it's being called from inside another
 * resource's own creation.
 *
 * This is what lets `A`'s argument resolving back to `A` itself (or to `B`,
 * which takes `A` as one of *its* arguments) be caught as the same kind of
 * cycle a static `inputs` cycle is, rather than deadlocking on a promise
 * awaiting its own settlement. See `specs/resource-arguments.md` §D.
 */
const chainContext = new AsyncLocalStorage<readonly ChainLink[]>();

/** A handle on the resources created for one execution. */
export interface ResourceLease {
  /**
   * Creates (or reuses) the value for `uri`, resolving its `inputs` first.
   * Calling twice for the same resource (with the same `binding`'s `key`, if
   * any) within one lease returns the same value — which is why resolution
   * takes every input together.
   *
   * @param binding - The resource's arguments and replay receipt, if any. See
   *   {@link ResourceBinding} and `specs/resource-arguments.md` §D.
   */
  acquire(uri: string, binding?: ResourceBinding): Promise<unknown>;
  /**
   * A serializable summary of each resource acquired, keyed by `uri` — or by
   * `` `${uri}@${key}` `` when it was acquired with arguments (`key` being
   * the {@link ResourceBinding.key} that produced the instance).
   */
  receipts(): Record<string, unknown>;
  /** Disposes this lease's run-scoped instances. Safe to call more than once. */
  release(): Promise<void>;
}

/** A resource's memoized instances, one per argument key (`""` for none). See `specs/resource-arguments.md` §D. */
type InstancesByKey = Map<string, Promise<Instance> | Instance>;

/**
 * Discovers **playground modules** and resolves the resources they export.
 *
 * Playground modules hold code that exists only to exercise a prompt from the
 * playground, and that the application itself must never import. They are
 * scoped by **location, never by export name**:
 *
 * | Scope   | Location                                                 | In scope for              |
 * | ------- | -------------------------------------------------------- | -------------------------- |
 * | Prompt  | `*.playground.ts` in the same directory as a prompt file | prompts in that directory |
 * | Project | any `*.ts` under `.evalution/playground/`                | every prompt in the workspace |
 *
 * `odin.playground.ts` beside `odin.prompt.ts` is the idiom, but the rule is
 * directory membership — so one module can serve several sibling prompt files,
 * and `.evalution/playground/` can be split across as many files as is
 * convenient.
 *
 * The export surface is an open set: the loader collects the exports it
 * recognises and ignores the rest, so helpers, types, and constants can be
 * colocated freely. {@link Resource} is the first recognised kind and
 * deliberately not the only one.
 */
export class ResourceRegistry {
  private readonly fileProvider: FileProvider;
  private readonly rootDir: string;
  private readonly includePatterns: readonly string[];
  private readonly ignorePatterns: readonly string[];

  /** Discovered resources by `uri`, or `null` before the first scan. */
  private resources: Map<string, RegisteredResource> | null = null;
  /**
   * Every resource *object* that stands for a discovered resource, mapped to
   * what it was registered as. A resource has more than one such object
   * whenever cache-busting is in play — see {@link scan}.
   */
  private identities = new Map<Resource<unknown>, RegisteredResource>();
  /** Modules that threw at import time, by absolute path. */
  private moduleErrors: PlaygroundModuleError[] = [];
  /** Memoized `scope: 'server'` instances, by resource object then argument key. */
  private serverInstances = new Map<Resource<unknown>, InstancesByKey>();
  /** The scan in flight, so concurrent callers don't each re-import. */
  private scanning: Promise<void> | null = null;
  /** Serializes leases' first use of a resettable server-scoped instance. See {@link ResetLockRegistry}. */
  private resetLocks = new ResetLockRegistry();

  constructor({
    fileProvider,
    rootDir,
    includePatterns = DEFAULT_PLAYGROUND_INCLUDE_PATTERNS,
    ignorePatterns = [],
  }: {
    fileProvider: FileProvider;
    rootDir: string;
    includePatterns?: readonly string[];
    ignorePatterns?: readonly string[];
  }) {
    this.fileProvider = fileProvider;
    this.rootDir = rootDir;
    this.includePatterns = includePatterns;
    this.ignorePatterns = ignorePatterns;
  }

  /** Absolute paths of the playground modules found by the last scan. */
  async modulePaths(): Promise<string[]> {
    const all = await this.all();
    const paths = new Set(all.map(r => r.modulePath));
    for (const e of this.moduleErrors) paths.add(e.modulePath);
    return [...paths].sort();
  }

  /** Every resource discovered, across all playground modules. */
  async all(): Promise<RegisteredResource[]> {
    return [...(await this.byUri()).values()];
  }

  /** Every selectable source, across all playground modules: every resource, plus one per declared output. */
  async sources(): Promise<RegisteredSource[]> {
    return (await this.all()).flatMap(sourcesFor);
  }

  /**
   * The sources in scope for a prompt in `promptFilePath`: every
   * project-scoped resource (and its values), plus those from
   * `*.playground.ts` modules in the same directory.
   *
   * @param promptFilePath - Absolute path of the prompt's source file.
   */
  async inScopeFor(promptFilePath: string): Promise<RegisteredSource[]> {
    const dir = path.dirname(promptFilePath);
    return (await this.all())
      .filter(r => !r.scopeDir || r.scopeDir === dir)
      .flatMap(sourcesFor);
  }

  /** Playground modules that failed to import, so the panel can say so. */
  async errors(): Promise<PlaygroundModuleError[]> {
    await this.byUri();
    return this.moduleErrors;
  }

  /**
   * Describes `sources` for the UI, including a snapshot of the value itself
   * where one is already known and safe to show — a static `value` resource,
   * or a `scope: 'server'` one this process has already created with no
   * arguments.
   *
   * A run-scoped resource never qualifies: its instance lives only for the
   * run that created it, so there is nothing memoized to peek at, and
   * showing one run's value as if it previewed the next would be wrong.
   * Neither does a value that isn't plain JSON data (see `isPlainSerializable`
   * below) — an opaque handle survives the trip through `describe` as a chip
   * with no preview, same as before this existed. An output source previews the
   * same way, reading its own path off the memoized instance.
   *
   * A `scope: 'server'` resource that declares arguments is reported with
   * {@link ResourceInfo.error} set rather than described normally — see
   * `specs/resource-arguments.md` §D.
   */
  describe(sources: readonly RegisteredSource[]): ResourceInfo[] {
    return sources.map(s => {
      const { params } = partitionInputs(s.resource.resource);
      const scope =
        s.resource.resource.scope ?? defaultScope(s.resource.resource);
      const invalidArgs = scope === "server" && params.length > 0;

      const instance = invalidArgs
        ? undefined
        : this.peekInstance(s.resource.resource);
      const read = instance
        ? readOutputPath(instance.value, s.outputPath)
        : undefined;
      const value =
        read?.found && isPlainSerializable(read.value)
          ? // A detached snapshot: `read.value` may be (a path into) the live
            // object the registry itself holds, and the check above already
            // proved it round-trips cleanly, so this can't lose information.
            (JSON.parse(JSON.stringify(read.value)) as unknown)
          : undefined;
      const info: ResourceInfo = {
        uri: s.uri,
        label: s.label,
        scope,
        value,
      };
      if (invalidArgs) info.error = serverScopedArgumentsError(s.resource.uri);
      if (s.group.length > 0) info.group = [...s.group];
      if (s.outputPath.length > 0) {
        info.parent = s.resource.uri;
        info.siblings = Object.keys(s.resource.resource.outputs ?? {}).length;
      }
      return info;
    });
  }

  /** The memoized no-argument instance for `target`, if one has already settled. */
  private peekInstance(target: Resource<unknown>): Instance | undefined {
    const cached = this.serverInstances.get(target)?.get("");
    return cached && !(cached instanceof Promise) ? cached : undefined;
  }

  /**
   * Forgets everything discovered so far and disposes memoized server-scoped
   * instances, so the next call re-imports.
   *
   * Called when a playground module changes: a server-scoped value created by
   * the old code must not outlive it.
   */
  async invalidate(): Promise<void> {
    this.resources = null;
    this.moduleErrors = [];
    const pending = [...this.serverInstances.values()].flatMap(byKey => [
      ...byKey.values(),
    ]);
    this.serverInstances = new Map();
    await Promise.all(
      pending.map(async p => {
        try {
          await (await p).dispose?.();
        } catch (err) {
          console.warn("failed to dispose playground resource:", err);
        }
      }),
    );
  }

  /**
   * Opens a lease over the resources needed by one execution. Every
   * run-scoped resource acquired through it is created once and disposed
   * together by {@link ResourceLease.release}.
   */
  lease(): ResourceLease {
    const runInstances = new Map<Resource<unknown>, InstancesByKey>();
    const acquired = new Map<string, { receipt?: unknown }>();
    const resetLocks = this.resetLocks.forLease();
    let released = false;

    const acquire = async (
      uri: string,
      binding?: ResourceBinding,
    ): Promise<unknown> => {
      const { rootUri, outputPath } = parseSourceUri(uri);
      const registered = (await this.byUri()).get(rootUri);
      if (!registered) throw new Error(`Resource '${uri}' not found`);
      const key = binding?.key ?? "";
      // A fresh top-level call has no ambient chain — `[]`, same as before
      // arguments existed. Reached instead from inside another resource's own
      // `create()` (its argument resolved back through here), the chain that
      // creation is running under is picked up via {@link chainContext} rather
      // than resetting to empty, which is what lets an argument cycle be
      // caught the same way a static `inputs` cycle is.
      const chain = chainContext.getStore() ?? [];
      const instance = await this.instantiate(
        registered.resource,
        rootUri,
        runInstances,
        chain,
        key,
        binding,
        resetLocks,
      );
      const read = readOutputPath(instance.value, outputPath);
      if (!read.found) {
        throw new Error(
          `Resource '${rootUri}': no output at '${outputPath.join(".")}'`,
        );
      }
      // A root reference and an output reference name the *same instance*, so
      // both record that instance's receipt, full stop — the output's own
      // value (even when it's plain JSON) is no longer substituted here.
      // That was right when a receipt was only ever displayed, but the
      // moment a receipt is fed back to `create` (§E), replaying an output
      // reference must not hand it the output's bare value where `create`
      // expects its own receipt shape. An author who wants the id shown in a
      // trace puts it in the receipt, which is what makes this no loss.
      const receipt = instance.receipt;
      acquired.set(receiptKeyOf(uri, key), { receipt });
      return read.value;
    };

    return {
      acquire,
      receipts: () =>
        Object.fromEntries(
          [...acquired].flatMap(([uri, e]) =>
            e.receipt === undefined ? [] : [[uri, e.receipt] as const],
          ),
        ),
      release: async () => {
        if (released) return;
        released = true;
        const pending = [...runInstances.values()].flatMap(byKey => [
          ...byKey.values(),
        ]);
        runInstances.clear();
        resetLocks.releaseAll();
        await Promise.all(
          pending.map(async p => {
            try {
              await (await p).dispose?.();
            } catch (err) {
              console.warn("failed to dispose playground resource:", err);
            }
          }),
        );
      },
    };
  }

  // #region Instantiation

  /**
   * Creates (or reuses) the instance for `target`, resolving its `inputs`
   * first — its dependencies, and, if `binding` is given, its arguments.
   *
   * Keyed on the resource **object**, not on its `uri`: a dependency is named
   * by reference, and a resource reached only that way (from a module the
   * discovery patterns don't cover) still has to resolve. `label` is what the
   * resource is called in errors — its `uri` where it has one. Further keyed
   * on `key` — {@link ResourceBinding.key}, or `""` for a resource with no
   * arguments — so two references to one resource with different arguments
   * resolve to two instances (`specs/resource-arguments.md` §D).
   *
   * `chain` is the dependency path taken to get here; it turns a cycle into a
   * legible error instead of a stack overflow. Cycles are detected on the
   * resource object alone, ignoring `key`: a resource that recursively seeds
   * itself with different arguments is not a case that exists, and erring
   * toward rejecting it is the safe side.
   */
  private async instantiate(
    target: Resource<unknown>,
    label: string,
    runInstances: Map<Resource<unknown>, InstancesByKey>,
    chain: readonly { resource: Resource<unknown>; label: string }[],
    key: string,
    binding: ResourceBinding | undefined,
    resetLocks: LeaseResetLocks,
  ): Promise<Instance> {
    if (chain.some(c => c.resource === target)) {
      throw new Error(
        `Resource dependency cycle: ${[...chain, { label }]
          .map(c => c.label)
          .join(" → ")}`,
      );
    }

    const scope = target.scope ?? defaultScope(target);
    const cache = scope === "server" ? this.serverInstances : runInstances;

    let byKey = cache.get(target);
    if (!byKey) {
      byKey = new Map();
      cache.set(target, byKey);
    }

    let pending = byKey.get(key);
    if (!pending) {
      const nextChain = [...chain, { resource: target, label }];
      // Ambient for the duration of `create()` — including its `await
      // binding.resolve()`, which is how an argument that resolves back
      // through `ResourceLease.acquire` (a public entry point with no chain
      // of its own) still sees this chain. See {@link chainContext}.
      pending = chainContext.run(nextChain, () =>
        this.create(
          target,
          label,
          scope,
          runInstances,
          nextChain,
          binding,
          resetLocks,
        ),
      );
      byKey.set(key, pending);
      const settledByKey = byKey;
      // A failed create must not be memoized as the resource's value, or every
      // later run in this process inherits the failure.
      pending.catch(() => settledByKey.delete(key));
      // Once a server-scoped create settles, replace the pending promise with
      // the instance itself so `describe()` can peek it synchronously without
      // re-running `create()` — that's the whole point of memoizing it.
      // Guarded on still being the cached entry: `invalidate()` may have
      // swapped in a fresh map while this was in flight, and the old value
      // must not leak into it.
      if (scope === "server") {
        pending
          .then(instance => {
            if (this.serverInstances.get(target)?.get(key) === pending) {
              this.serverInstances.get(target)!.set(key, instance);
            }
          })
          // A rejection is already handled by the `.catch` above, on the same
          // `pending` — this chain off of it needs its own no-op handler or
          // it reports the same rejection again as unhandled.
          .catch(() => {});
      }
    }

    const instance = await pending;

    if (scope === "server" && instance.reset) {
      const sortKey = key ? `${label}@${key}` : label;
      const isNewToThisLease = await resetLocks.enter(target, key, sortKey);
      if (isNewToThisLease) await instance.reset();
    } else if (
      scope === "run" &&
      instance.reset &&
      !warnedRunScopedReset.has(target)
    ) {
      warnedRunScopedReset.add(target);
      console.warn(
        `⚠️ Resource '${label}' declares reset() but is run-scoped — it is ` +
          `created fresh per run, so reset() will never be called. See ` +
          `specs/resource-arguments.md §F.`,
      );
    }

    return instance;
  }

  private async create(
    target: Resource<unknown>,
    label: string,
    scope: ResourceScope,
    runInstances: Map<Resource<unknown>, InstancesByKey>,
    chain: readonly { resource: Resource<unknown>; label: string }[],
    binding: ResourceBinding | undefined,
    resetLocks: LeaseResetLocks,
  ): Promise<Instance> {
    if ("value" in target) {
      if (binding) {
        throw new Error(
          `Resource '${label}': static resources take no arguments`,
        );
      }
      return target;
    }

    const { deps, params } = partitionInputs(target);

    if (params.length > 0 && scope === "server") {
      throw new Error(serverScopedArgumentsError(label));
    }

    const resolved: Record<string, unknown> = {};

    for (const [name, dep] of deps) {
      // A dependency arrives as whichever object the depending module's own
      // import produced, which is not necessarily the one discovery
      // registered. `byIdentity` maps both onto one registration so the value
      // is created once; an unregistered dependency is instantiated as itself.
      const registered = (await this.byIdentity()).get(dep);
      const depTarget = registered?.resource ?? dep;
      const depLabel = registered?.uri ?? `${label} → ${name}`;

      const depScope = depTarget.scope ?? defaultScope(depTarget);
      if (scope === "server" && depScope === "run") {
        throw new Error(
          `Resource '${label}' is server-scoped but needs '${depLabel}', which is ` +
            `run-scoped. A value that outlives the run must not close over one that doesn't.`,
        );
      }
      resolved[name] = (
        await this.instantiate(
          depTarget,
          depLabel,
          runInstances,
          chain,
          "",
          undefined,
          resetLocks,
        )
      ).value;
    }

    if (params.length > 0) {
      // Lazy, and only evaluated here — never for a binding that hits the
      // memo — because arguments must not be resolved (and a resource used
      // as one of them must not be created) for a slot no one is actually
      // filling from this call.
      const argValues = (await binding?.resolve()) ?? {};
      for (const [name, schema] of params) {
        const result = await schema["~standard"].validate(argValues[name]);
        if (result.issues) {
          const message = result.issues.map(i => i.message).join(", ");
          throw new Error(
            `Resource '${label}': invalid value for '${name}' — ${message}`,
          );
        }
        resolved[name] = result.value;
      }
    }

    const instance = await target.create(resolved, binding?.receipt);
    if (!instance || typeof instance !== "object" || !("value" in instance)) {
      throw new Error(
        `Resource '${label}': create() must return { value, dispose? }`,
      );
    }
    return instance;
  }

  /** {@link identities}, after making sure a scan has happened. */
  private async byIdentity(): Promise<
    Map<Resource<unknown>, RegisteredResource>
  > {
    await this.byUri();
    return this.identities;
  }

  private async byUri(): Promise<Map<string, RegisteredResource>> {
    if (this.resources) return this.resources;
    // One scan at a time: `all()`, `errors()` and a lease's first `acquire()`
    // routinely race, and each import is a module evaluation worth doing once.
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null;
    });
    await this.scanning;
    return this.resources!;
  }

  // #endregion
  // #region Discovery

  private async scan(): Promise<void> {
    const found = new Map<string, RegisteredResource>();
    const identities = new Map<Resource<unknown>, RegisteredResource>();
    const errors: PlaygroundModuleError[] = [];

    for (const modulePath of await this.findModules()) {
      let namespace: Record<string, unknown>;
      try {
        namespace = await this.fileProvider.import(modulePath, { fresh: true });
      } catch (err: any) {
        // One broken playground module must not take the others — or the
        // server — down. It surfaces in the panel as unavailable instead.
        const message = err?.message ?? String(err);
        console.warn(
          `⚠️ playground module ${modulePath} failed to load: ${message}`,
        );
        errors.push({ modulePath, message });
        continue;
      }

      // The same module, imported the way *another module's* `import` of it
      // resolves — no cache-busting query. Node keys its module cache on the
      // full specifier, so a busted import and a plain one are two evaluations
      // producing two distinct resource objects for the same declaration, and
      // `inputs` (which is by reference) hands over whichever one the depending
      // module happened to bind. Mapping both onto one registration is what
      // keeps a dependency resolvable *and* created once per run. Best-effort:
      // the busted import above is the one whose failure is worth reporting.
      const shared: Record<string, unknown> = await this.fileProvider
        .import(modulePath)
        .catch(() => ({}));

      const relativePath = path.relative(this.rootDir, modulePath);
      const projectScoped = !relativePath.split(path.sep).includes("..")
        ? relativePath.replace(/\\/g, "/").startsWith(".evalution/")
        : false;

      for (const [key, value] of Object.entries(namespace)) {
        // The export surface is open: anything unrecognised is a helper, a
        // type, or a constant the author colocated, and is simply skipped.
        if (!isResource(value)) continue;
        const uri = `${relativePath.replace(/\\/g, "/")}#${key}`;
        const registered: RegisteredResource = {
          uri,
          key,
          modulePath,
          scopeDir: projectScoped ? undefined : path.dirname(modulePath),
          resource: value,
        };
        found.set(uri, registered);
        identities.set(value, registered);
        const alias = shared[key];
        if (isResource(alias)) identities.set(alias, registered);
        if ("value" in value) {
          this.serverInstances.set(value, new Map([["", value]]));
        }
      }
    }

    this.resources = found;
    this.identities = identities;
    this.moduleErrors = errors;
  }

  private async findModules(): Promise<string[]> {
    const unique = new Set<string>();
    for (const pattern of this.includePatterns) {
      const iter = this.fileProvider.glob(pattern, {
        cwd: this.rootDir,
        absolute: true,
        ignore: this.ignorePatterns,
      });
      for await (const file of iter) unique.add(file);
    }
    return [...unique].sort();
  }

  // #endregion
}
