// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FileProvider } from "../../file-provider.ts";
import { isValidInstanceName } from "../../shared/instance-names.ts";
import type { ResourceInfo, ResourceScope } from "../../shared/types.ts";
import { type Check, isCheck } from "./check.ts";
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

/** One discovered check. See `specs/evals.md` §B.4. */
export interface RegisteredCheck {
  /** `<module path relative to rootDir>#<export name>`. */
  uri: string;
  /** The export name within its module. */
  key: string;
  /** Absolute path of the playground module that exported it. */
  modulePath: string;
  /** The `check()` object itself. */
  check: Check;
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
function partitionInputs(
  target: { inputs?: ResourceInputs; label?: string },
  noun = "Resource",
): PartitionedInputs {
  const inputs: ResourceInputs =
    "inputs" in target ? (target.inputs ?? {}) : {};
  const deps: [string, Resource<unknown>][] = [];
  const params: [string, StandardSchemaV1][] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (isResource(value)) deps.push([name, value]);
    else if (isStandardSchema(value)) params.push([name, value]);
    else {
      const label = target.label ?? noun.toLowerCase();
      throw new Error(
        `${noun} '${label}': input '${name}' must be a resource or a ` +
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
export function resourceParameterNames(target: {
  inputs?: ResourceInputs;
  label?: string;
}): string[] {
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
 * A declared instance's arguments and replay receipt, as the lease sees them.
 *
 * Built by `resolveExecutionInputs` from a `ResourceInstanceInput` — the
 * layer that knows how to turn its `args` into values — so the registry never
 * has to know `ExecutionInput` exists. See `specs/resource-instances.md` §B.
 */
export interface ResourceBinding {
  /**
   * Resolves the arguments, keyed by parameter name. Called at most once per
   * instance, lazily — only when the instance is actually created, so a
   * failed `create` has no side effects from arguments no one asked for.
   * Absent when the instance was declared with no arguments.
   */
  resolve?(): Promise<Record<string, unknown>>;
  /** A past run's receipt, on a replay. Passed to `create`. */
  receipt?: unknown;
}

/**
 * One named instance a run declares — what {@link ResourceLease.declare}
 * takes. See `specs/resource-instances.md` §A.
 */
export interface DeclaredInstance {
  /** The resource's root `uri` (`tasks.ts#seededTask`), never an output's. */
  uri: string;
  /** Its arguments and replay receipt, if it has either. */
  binding?: ResourceBinding;
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
 *
 * A lease's inputs resolve in parallel, so it may need the same lock from
 * several places at once. Each (resource, key) is entered once per lease, and
 * every caller waits on that one entry — reset included — rather than
 * queueing on a mutex its own lease already holds. Lock acquisitions within
 * the lease take turns, so the reacquire above never interleaves with itself.
 */
class LeaseResetLocks {
  private held: {
    sortKey: string;
    target: Resource<unknown>;
    key: string;
    release: () => void;
  }[] = [];
  private entries = new Map<Resource<unknown>, Map<string, Promise<void>>>();
  /** The lease's lock acquisitions, one at a time. */
  private turn: Promise<unknown> = Promise.resolve();
  private readonly registry: ResetLockRegistry;

  constructor(registry: ResetLockRegistry) {
    this.registry = registry;
  }

  /**
   * Locks (resource, key) for this lease's lifetime and runs `reset` once it
   * holds the lock. Every call for the same (resource, key) in this lease —
   * concurrent or later — resolves when that one reset has finished.
   */
  enter(
    target: Resource<unknown>,
    key: string,
    sortKey: string,
    reset: () => Promise<void>,
  ): Promise<void> {
    let byKey = this.entries.get(target);
    if (!byKey) {
      byKey = new Map();
      this.entries.set(target, byKey);
    }
    let entry = byKey.get(key);
    if (!entry) {
      const locked = this.turn.then(() => this.lock(target, key, sortKey));
      this.turn = locked.catch(() => {});
      entry = locked.then(reset);
      byKey.set(key, entry);
    }
    return entry;
  }

  private async lock(
    target: Resource<unknown>,
    key: string,
    sortKey: string,
  ): Promise<void> {
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
  }

  releaseAll(): void {
    for (const h of this.held) h.release();
    this.held = [];
  }
}

/**
 * Wraps a failure thrown by author-written resource code (`create()`,
 * `reset()`) so the message says which resource it came from. Without it the
 * error is whatever the author's code happened to throw — `Cannot read
 * properties of undefined` — with nothing tying it to a resource, and the
 * stack (kept as `cause`) is only in the server log.
 */
function resourceFailure(label: string, phase: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Resource '${label}': ${phase} failed — ${message}`, {
    cause: err,
  });
}

/**
 * Validates `values` against each schema-valued input, returning the
 * validated values by name — or throwing, naming the input and the issue.
 *
 * @param owner - What the inputs belong to, for the message
 *   (`Resource 'db.ts#seeded'`, `Check 'checks.ts#createsTask'`).
 */
export async function validateArguments(
  params: readonly [string, StandardSchemaV1][],
  values: Record<string, unknown>,
  owner: string,
): Promise<Record<string, unknown>> {
  const validated: Record<string, unknown> = {};
  for (const [name, schema] of params) {
    const result = await schema["~standard"].validate(values[name]);
    if (result.issues) {
      const message = result.issues.map(i => i.message).join(", ");
      throw new Error(`${owner}: invalid value for '${name}' — ${message}`);
    }
    validated[name] = result.value;
  }
  return validated;
}

/** Resources already warned about a `reset` that will never run, so the message appears once each. */
const warnedRunScopedReset = new WeakSet<Resource<unknown>>();

/**
 * One link in a resource's dependency chain, for cycle detection and error
 * messages. `key` is the instance's memo key — its name for a declared
 * run-scoped instance, `""` for a server-scoped or undeclared one — so two
 * instances of one resource are two links, and a child task seeded from its
 * parent's id is not mistaken for a cycle (`specs/resource-instances.md` §B).
 */
interface ChainLink {
  resource: Resource<unknown>;
  key: string;
  label: string;
}

/**
 * Carries the dependency chain across `create()`'s `await binding.resolve()`
 * — the point where resolution leaves the registry's own call stack and
 * re-enters it through `ResourceLease.acquire`, a public entry point that
 * otherwise has no way to know it's being called from inside another
 * resource's own creation.
 *
 * This is what lets an instance's argument resolving back to the instance
 * itself (or to one that takes it as one of *its* arguments) be caught as the
 * same kind of cycle a static `inputs` cycle is, rather than deadlocking on a
 * promise awaiting its own settlement.
 */
const chainContext = new AsyncLocalStorage<readonly ChainLink[]>();

/** A handle on the resources created for one execution. */
export interface ResourceLease {
  /**
   * Declares the run's named instances. Called once, before anything is
   * acquired. Rejects a name that is invalid, a `uri` that names no resource
   * or names an output rather than a resource, and a `server`-scoped or
   * static resource declared under more than one name — it has one instance
   * per process, so two names would alias it. See
   * `specs/resource-instances.md` §B.
   */
  declare(instances: Record<string, DeclaredInstance>): Promise<void>;
  /**
   * Creates (or reuses) the declared instance `name`, resolving its `inputs`
   * first, and returns its value — or, given `output`, that top-level
   * property of it. Every call for the same name within one lease returns the
   * same instance.
   */
  acquire(name: string, output?: string): Promise<unknown>;
  /**
   * A serializable summary of what each declared instance produced, by
   * instance name — its `create()`'s `receipt`. Instances that produced none
   * are absent.
   */
  receipts(): Record<string, unknown>;
  /**
   * Resolves a check's declared `inputs` within this lease: each resource
   * entry is the instance this lease already has (or creates it, as a
   * dependency would be), and each schema entry is read from `args` and
   * validated. See `specs/evals.md` §B.1.
   *
   * @param label - What to call the check in an error.
   * @param args - Resolves the eval's bindings for the schema entries.
   *   Called at most once, and only when there are any.
   */
  resolveDeclared(
    inputs: ResourceInputs | undefined,
    label: string,
    args: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** Disposes this lease's run-scoped instances. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * A resource's memoized instances, by memo key: the instance name for a
 * declared run-scoped instance, `""` for a server-scoped or undeclared one.
 */
type InstancesByKey = Map<string, Promise<Instance> | Instance>;

/** One lease's own state, threaded through instantiation. */
interface LeaseState {
  runInstances: Map<Resource<unknown>, InstancesByKey>;
  resetLocks: LeaseResetLocks;
  /** The run's declared instances, by name, with their registrations. */
  declared: Map<string, DeclaredInstance & { registered: RegisteredResource }>;
  /** Receipts recorded so far, by instance name. */
  receipts: Map<string, unknown>;
  /** Set by `release()`: nothing more may be created for this run. */
  released: boolean;
  /**
   * Which instance creations are waiting on which, by {@link nodeId}: the
   * wait-for graph that catches a cycle `chain` can't — two creations that
   * started on separate async paths (declared instances are acquired in
   * parallel) and then each await the other's pending promise.
   */
  waits: Map<string, string[]>;
  /** What each {@link nodeId} is called in a cycle error. */
  labels: Map<string, string>;
}

/** A stable id per resource object, for {@link nodeId}. */
const resourceIds = new WeakMap<Resource<unknown>, number>();
let nextResourceId = 0;

/** Identifies one instance — (resource, memo key) — in a lease's wait-for graph. */
function nodeId(resource: Resource<unknown>, key: string): string {
  let id = resourceIds.get(resource);
  if (id === undefined) {
    id = nextResourceId++;
    resourceIds.set(resource, id);
  }
  return `${id}:${key}`;
}

/** A path from `from` to `to` along `waits`, both ends included; `undefined` if none. */
function waitPath(
  waits: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): string[] | undefined {
  const seen = new Set<string>();
  const walk = (at: string): string[] | undefined => {
    if (at === to) return [at];
    if (seen.has(at)) return undefined;
    seen.add(at);
    for (const next of waits.get(at) ?? []) {
      const rest = walk(next);
      if (rest) return [at, ...rest];
    }
    return undefined;
  };
  return walk(from);
}

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
  /** Discovered checks by `uri`, from the same scan. */
  private checkMap = new Map<string, RegisteredCheck>();
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
    for (const c of this.checkMap.values()) paths.add(c.modulePath);
    for (const e of this.moduleErrors) paths.add(e.modulePath);
    return [...paths].sort();
  }

  /** Every resource discovered, across all playground modules. */
  async all(): Promise<RegisteredResource[]> {
    return [...(await this.byUri()).values()];
  }

  /** Every check discovered, across all playground modules, by `uri`. See `specs/evals.md` §B.4. */
  async checks(): Promise<RegisteredCheck[]> {
    await this.byUri();
    return [...this.checkMap.values()];
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
      const { deps, params } = partitionInputs(s.resource.resource);
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
      if (s.outputPath.length === 0) {
        const dependencies = Object.fromEntries(
          deps.flatMap(([name, dep]) => {
            const uri = this.identities.get(dep)?.uri;
            return uri ? [[name, uri] as const] : [];
          }),
        );
        if (Object.keys(dependencies).length > 0) {
          info.dependencies = dependencies;
        }
      }
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
    const state: LeaseState = {
      runInstances: new Map(),
      resetLocks: this.resetLocks.forLease(),
      declared: new Map(),
      receipts: new Map(),
      released: false,
      waits: new Map(),
      labels: new Map(),
    };

    const declare = async (
      instances: Record<string, DeclaredInstance>,
    ): Promise<void> => {
      const byUri = await this.byUri();
      const sharedBy = new Map<Resource<unknown>, string>();
      for (const [name, decl] of Object.entries(instances)) {
        if (!isValidInstanceName(name)) {
          throw new Error(
            `Invalid resource instance name '${name}': use letters, digits, '_' and '-', not starting with a digit or '-'.`,
          );
        }
        const { rootUri, outputPath } = parseSourceUri(decl.uri);
        if (outputPath.length > 0) {
          throw new Error(
            `Resource instance '${name}': '${decl.uri}' names an output, not a resource — declare '${rootUri}' and read the output where it's used.`,
          );
        }
        const registered = byUri.get(rootUri);
        if (!registered) {
          throw new Error(
            `Resource instance '${name}': resource '${decl.uri}' not found`,
          );
        }
        const target = registered.resource;
        if ((target.scope ?? defaultScope(target)) === "server") {
          const other = sharedBy.get(target);
          if (other) {
            throw new Error(
              `Resource '${rootUri}' is shared by every run (server-scoped), so it can only be declared once — '${other}' and '${name}' would be the same instance.`,
            );
          }
          sharedBy.set(target, name);
        }
        state.declared.set(name, { ...decl, registered });
      }
    };

    const acquire = async (name: string, output?: string): Promise<unknown> => {
      await this.byUri();
      const instance = await this.instantiateDeclared(
        name,
        state,
        chainContext.getStore() ?? [],
      );
      if (output === undefined) return instance.value;
      const read = readOutputPath(instance.value, [output]);
      if (!read.found) {
        throw new Error(`Resource instance '${name}': no output '${output}'`);
      }
      return read.value;
    };

    const resolveDeclared = async (
      inputs: ResourceInputs | undefined,
      label: string,
      args: () => Promise<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const { deps, params } = partitionInputs({ inputs, label }, "Check");
      const resolved = await this.resolveDeps(
        deps,
        label,
        "run",
        state,
        chainContext.getStore() ?? [],
      );
      if (params.length > 0) {
        Object.assign(
          resolved,
          await validateArguments(params, await args(), `Check '${label}'`),
        );
      }
      return resolved;
    };

    return {
      declare,
      acquire,
      resolveDeclared,
      receipts: () => Object.fromEntries(state.receipts),
      release: async () => {
        if (state.released) return;
        state.released = true;
        const pending = [...state.runInstances.values()].flatMap(byKey => [
          ...byKey.values(),
        ]);
        state.runInstances.clear();
        state.resetLocks.releaseAll();
        await Promise.all(
          pending.map(async p => {
            // A create that failed (or was refused once released) left
            // nothing to dispose; only a real dispose failure is worth a
            // warning.
            const instance = await Promise.resolve(p).catch(() => undefined);
            try {
              await instance?.dispose?.();
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
   * Creates (or reuses) the run's declared instance `name`, recording its
   * receipt. Keyed by name for a run-scoped resource, so two instances of one
   * resource are two `create()`s even with identical arguments; a
   * server-scoped one has a single instance per process however it's named.
   */
  private async instantiateDeclared(
    name: string,
    state: LeaseState,
    chain: readonly ChainLink[],
  ): Promise<Instance> {
    const decl = state.declared.get(name);
    if (!decl) throw new Error(`No resource instance named '${name}'`);
    const target = decl.registered.resource;
    const label = `${name} (${decl.registered.uri})`;
    // Checked here rather than in `create`: a static resource's one instance
    // exists from discovery on, so `create` never runs for it.
    if ("value" in target && decl.binding?.resolve) {
      throw new Error(
        `Resource '${label}': static resources take no arguments`,
      );
    }
    const scope = target.scope ?? defaultScope(target);
    const instance = await this.instantiate(
      target,
      label,
      state,
      chain,
      scope === "server" ? "" : name,
      decl.binding,
    );
    if (instance.receipt !== undefined) {
      state.receipts.set(name, instance.receipt);
    }
    return instance;
  }

  /**
   * Creates (or reuses) the instance for `target` under memo key `key`,
   * resolving its `inputs` first — its dependencies, and, if `binding`
   * resolves any, its arguments.
   *
   * Keyed on the resource **object**, not on its `uri`: a dependency is named
   * by reference, and a resource reached only that way (from a module the
   * discovery patterns don't cover) still has to resolve. `label` is what the
   * resource is called in errors.
   *
   * `chain` is the dependency path taken to get here; it turns a cycle into a
   * legible error instead of a stack overflow. A cycle is the same
   * (resource, key) reached twice — so `child1.parentId ← root.taskId` is
   * two instances of one resource and fine, while two instances each taking
   * the other's id is not.
   */
  private async instantiate(
    target: Resource<unknown>,
    label: string,
    state: LeaseState,
    chain: readonly ChainLink[],
    key: string,
    binding: ResourceBinding | undefined,
  ): Promise<Instance> {
    if (chain.some(c => c.resource === target && c.key === key)) {
      throw new Error(
        `Resource dependency cycle: ${[...chain, { label }]
          .map(c => c.label)
          .join(" → ")}`,
      );
    }
    // After `release()` the run's memo is gone: creating now would make a
    // second instance of something already disposed, and nothing would
    // dispose this one.
    if (state.released) {
      throw new Error(`Resource '${label}': the run has already finished`);
    }

    const scope = target.scope ?? defaultScope(target);
    const cache =
      scope === "server" ? this.serverInstances : state.runInstances;

    let byKey = cache.get(target);
    if (!byKey) {
      byKey = new Map();
      cache.set(target, byKey);
    }

    // The creation this one is needed by, if any, now waits on it.
    const self = nodeId(target, key);
    const waiter = chain.at(-1);
    const waiterId = waiter && nodeId(waiter.resource, waiter.key);
    state.labels.set(self, label);

    let pending = byKey.get(key);
    if (pending && waiterId) {
      // Joining a creation already under way: if it (transitively) waits on
      // the one asking, neither would ever finish.
      const loop = waitPath(state.waits, self, waiterId);
      if (loop) {
        throw new Error(
          `Resource dependency cycle: ${[waiterId, ...loop]
            .map(id => state.labels.get(id) ?? id)
            .join(" → ")}`,
        );
      }
    }
    if (!pending) {
      const nextChain = [...chain, { resource: target, key, label }];
      // Ambient for the duration of `create()` — including its `await
      // binding.resolve()`, which is how an argument that resolves back
      // through `ResourceLease.acquire` (a public entry point with no chain
      // of its own) still sees this chain. See {@link chainContext}.
      pending = chainContext.run(nextChain, () =>
        this.create(target, label, scope, state, nextChain, binding),
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

    let instance: Instance;
    if (waiterId) {
      const edges = state.waits.get(waiterId) ?? [];
      edges.push(self);
      state.waits.set(waiterId, edges);
      try {
        instance = await pending;
      } finally {
        edges.splice(edges.indexOf(self), 1);
      }
    } else {
      instance = await pending;
    }

    if (scope === "server" && instance.reset) {
      // Sorted by the resource's own uri, which every lease agrees on — not
      // `label`, which carries whatever instance name this run gave it.
      const sortKey = (await this.byIdentity()).get(target)?.uri ?? label;
      await state.resetLocks.enter(target, key, sortKey, async () => {
        try {
          await instance.reset!();
        } catch (err) {
          throw resourceFailure(label, "reset()", err);
        }
      });
    } else if (
      scope === "run" &&
      instance.reset &&
      !warnedRunScopedReset.has(target)
    ) {
      warnedRunScopedReset.add(target);
      console.warn(
        `⚠️ Resource '${label}' declares reset() but is run-scoped — it is ` +
          `created fresh per run, so reset() will never be called.`,
      );
    }

    return instance;
  }

  private async create(
    target: Resource<unknown>,
    label: string,
    scope: ResourceScope,
    state: LeaseState,
    chain: readonly ChainLink[],
    binding: ResourceBinding | undefined,
  ): Promise<Instance> {
    if ("value" in target) {
      return target;
    }

    const { deps, params } = partitionInputs(target);

    if (params.length > 0 && scope === "server") {
      throw new Error(serverScopedArgumentsError(label));
    }

    const resolved = await this.resolveDeps(deps, label, scope, state, chain);

    if (params.length > 0) {
      // Lazy, and only evaluated here — never for an instance that's already
      // memoized — because arguments must not be resolved (and an instance
      // used as one of them must not be created) for nothing.
      const argValues = (await binding?.resolve?.()) ?? {};
      Object.assign(
        resolved,
        await validateArguments(params, argValues, `Resource '${label}'`),
      );
    }

    let instance: Instance;
    try {
      instance = await target.create(resolved, binding?.receipt);
    } catch (err) {
      throw resourceFailure(label, "create()", err);
    }
    if (!instance || typeof instance !== "object" || !("value" in instance)) {
      throw new Error(
        `Resource '${label}': create() must return { value, dispose? }`,
      );
    }
    return instance;
  }

  /**
   * Creates (or reuses) each of `deps` — code-wired dependencies, named by
   * resource object — for something `label` names, which lives for `scope`.
   *
   * A dependency is the run's declared instance of that resource when it
   * declares exactly one, so arguments configured in the Resources section
   * reach the instance that depends on it. With none declared it is the
   * undeclared instance (memo key `""`), created with no arguments; with
   * several it's ambiguous and fails. See `specs/resource-instances.md` §D.
   */
  private async resolveDeps(
    deps: readonly [string, Resource<unknown>][],
    label: string,
    scope: ResourceScope,
    state: LeaseState,
    chain: readonly ChainLink[],
  ): Promise<Record<string, unknown>> {
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

      const declaredAs = [...state.declared]
        .filter(([, d]) => d.registered.resource === depTarget)
        .map(([instanceName]) => instanceName);
      if (declaredAs.length > 1) {
        throw new Error(
          `Resource '${label}' needs '${depLabel}' as '${name}', but this run declares ` +
            `more than one instance of it (${declaredAs.join(", ")}) — it can't tell which.`,
        );
      }
      resolved[name] = (
        declaredAs.length === 1
          ? await this.instantiateDeclared(declaredAs[0], state, chain)
          : await this.instantiate(
              depTarget,
              depLabel,
              state,
              chain,
              "",
              undefined,
            )
      ).value;
    }
    return resolved;
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
    const checks = new Map<string, RegisteredCheck>();
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
        const uri = `${relativePath.replace(/\\/g, "/")}#${key}`;
        if (isCheck(value)) {
          checks.set(uri, { uri, key, modulePath, check: value });
          continue;
        }
        // The export surface is open: anything unrecognised is a helper, a
        // type, or a constant the author colocated, and is simply skipped.
        if (!isResource(value)) continue;
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
    this.checkMap = checks;
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
