// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { FileProvider } from "../../file-provider.ts";
import type { ResourceInfo, ResourceScope } from "../../shared/types.ts";
import { isResource, type Resource, type ResourceNeeds } from "./resource.ts";

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
}

/**
 * A handle on the resources created for one execution.
 *
 * Run-scoped instances live for exactly as long as this lease; server-scoped
 * ones are memoized on the registry and untouched by {@link release}.
 */
export interface ResourceLease {
  /**
   * Creates (or reuses) the value for `uri`, resolving its `needs` first.
   * Calling twice for the same resource within one lease returns the same
   * value — which is why resolution takes every input together.
   */
  acquire(uri: string): Promise<unknown>;
  /** A serializable summary of each resource acquired, keyed by `uri`. */
  receipts(): Record<string, unknown>;
  /** Disposes this lease's run-scoped instances. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Discovers **playground modules** and resolves the resources they export.
 *
 * Playground modules hold code that exists only to exercise a prompt from the
 * playground, and that the application itself must never import. They are
 * scoped by **location, never by export name**:
 *
 * | Scope   | Location                                                 | In scope for              |
 * | ------- | -------------------------------------------------------- | ------------------------- |
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
  /** Memoized `scope: 'server'` instances, by the resource they belong to. */
  private serverInstances = new Map<Resource<unknown>, Promise<Instance>>();
  /** The scan in flight, so concurrent callers don't each re-import. */
  private scanning: Promise<void> | null = null;

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

  /**
   * The resources in scope for a prompt in `promptFilePath`: every
   * project-scoped one, plus those from `*.playground.ts` modules in the same
   * directory.
   *
   * @param promptFilePath - Absolute path of the prompt's source file.
   */
  async inScopeFor(promptFilePath: string): Promise<RegisteredResource[]> {
    const dir = path.dirname(promptFilePath);
    return (await this.all()).filter(r => !r.scopeDir || r.scopeDir === dir);
  }

  /** Playground modules that failed to import, so the panel can say so. */
  async errors(): Promise<PlaygroundModuleError[]> {
    await this.byUri();
    return this.moduleErrors;
  }

  /** Describes `resources` for the UI. Values are never included. */
  describe(resources: readonly RegisteredResource[]): ResourceInfo[] {
    return resources.map(r => ({
      uri: r.uri,
      label: r.resource.label ?? r.key,
      scope: r.resource.scope ?? ("run" as ResourceScope),
    }));
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
    const pending = [...this.serverInstances.values()];
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
    const runInstances = new Map<Resource<unknown>, Promise<Instance>>();
    const acquired = new Map<string, Instance>();
    let released = false;

    const acquire = async (uri: string): Promise<unknown> => {
      const registered = (await this.byUri()).get(uri);
      if (!registered) throw new Error(`Resource '${uri}' not found`);
      const instance = await this.instantiate(
        registered.resource,
        uri,
        runInstances,
        [],
      );
      acquired.set(uri, instance);
      return instance.value;
    };

    return {
      acquire,
      receipts: () =>
        Object.fromEntries(
          [...acquired].flatMap(([uri, i]) =>
            i.receipt === undefined ? [] : [[uri, i.receipt] as const],
          ),
        ),
      release: async () => {
        if (released) return;
        released = true;
        const pending = [...runInstances.values()];
        runInstances.clear();
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
   * Creates (or reuses) the instance for `target`, resolving its `needs` first.
   *
   * Keyed on the resource **object**, not on its `uri`: a dependency is named
   * by reference, and a resource reached only that way (from a module the
   * discovery patterns don't cover) still has to resolve. `label` is what the
   * resource is called in errors — its `uri` where it has one.
   *
   * `chain` is the dependency path taken to get here; it turns a cycle into a
   * legible error instead of a stack overflow.
   */
  private async instantiate(
    target: Resource<unknown>,
    label: string,
    runInstances: Map<Resource<unknown>, Promise<Instance>>,
    chain: readonly { resource: Resource<unknown>; label: string }[],
  ): Promise<Instance> {
    if (chain.some(c => c.resource === target)) {
      throw new Error(
        `Resource dependency cycle: ${[...chain, { label }]
          .map(c => c.label)
          .join(" → ")}`,
      );
    }

    const scope = target.scope ?? "run";
    const cache = scope === "server" ? this.serverInstances : runInstances;

    let pending = cache.get(target);
    if (!pending) {
      pending = this.create(target, label, scope, runInstances, [
        ...chain,
        { resource: target, label },
      ]);
      cache.set(target, pending);
      // A failed create must not be memoized as the resource's value, or every
      // later run in this process inherits the failure.
      pending.catch(() => cache.delete(target));
    }
    return pending;
  }

  private async create(
    target: Resource<unknown>,
    label: string,
    scope: ResourceScope,
    runInstances: Map<Resource<unknown>, Promise<Instance>>,
    chain: readonly { resource: Resource<unknown>; label: string }[],
  ): Promise<Instance> {
    const needs: ResourceNeeds = target.needs ?? {};
    const resolved: Record<string, unknown> = {};

    for (const [name, dep] of Object.entries(needs)) {
      // A dependency arrives as whichever object the depending module's own
      // import produced, which is not necessarily the one discovery
      // registered. `byIdentity` maps both onto one registration so the value
      // is created once; an unregistered dependency is instantiated as itself.
      const registered = (await this.byIdentity()).get(dep);
      const depTarget = registered?.resource ?? dep;
      const depLabel = registered?.uri ?? `${label} → ${name}`;

      const depScope = depTarget.scope ?? "run";
      if (scope === "server" && depScope === "run") {
        throw new Error(
          `Resource '${label}' is server-scoped but needs '${depLabel}', which is ` +
            `run-scoped. A value that outlives the run must not close over one that doesn't.`,
        );
      }
      resolved[name] = (
        await this.instantiate(depTarget, depLabel, runInstances, chain)
      ).value;
    }

    const instance = await target.create(resolved);
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
      // `needs` (which is by reference) hands over whichever one the depending
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
