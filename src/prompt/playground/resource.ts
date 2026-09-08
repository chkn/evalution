// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { ResourceScope } from "../../shared/types.ts";

/**
 * Brand identifying a value produced by {@link resource}. The loader walks a
 * playground module's exports and collects anything carrying it, so adding a
 * new kind of playground export means teaching the loader one more tag rather
 * than changing discovery.
 */
export const RESOURCE_TAG = Symbol.for("evalution.playground.resource");

/**
 * What a resource's `create()` hands back: the value itself, plus an optional
 * teardown to run when the value's scope ends.
 *
 * @typeParam T - The type of the created value.
 */
export interface ResourceInstance<T> {
  /** The created value, passed to whatever slot selected this resource. */
  value: T;
  /**
   * Releases whatever `create()` acquired. Called once, when the run settles
   * (`scope: 'run'`) or at shutdown / on module change (`scope: 'server'`).
   */
  dispose?: () => void | Promise<void>;
  /**
   * A serializable summary of what was produced (a seeded row's id, say), so a
   * trace can display the value a past run used even though replaying it mints
   * a new one. Omit for values with no meaningful summary.
   */
  receipt?: unknown;
}

/**
 * The set of resources another resource depends on, keyed by the name its
 * `create()` receives them under.
 *
 * Dependencies are given as the resource *values* themselves rather than as
 * string keys: the registry resolves them by identity, so `create`'s argument
 * is typed from the dependency and there is no key-collision problem across
 * the many files a `.evalution/playground/` directory may hold.
 */
export type ResourceNeeds = Record<string, Resource<any>>;

/**
 * One named value a resource exposes as its own entry in the picker, read as
 * a top-level property off whatever `create()` (or a static `value`)
 * produces.
 *
 * A resource exposing `values` still produces one value from one `create()` —
 * `ResourceRegistry.instantiate` memoizes by resource *object* within a
 * lease, so picking one value for one slot and another for a different slot
 * creates the underlying value once, not twice. Declaring a key here is
 * opt-in: it is the author saying which paths are meaningful inputs, the same
 * judgement {@link DynamicResourceDefinition.label} already is. See
 * `specs/resource-hierarchy.md` §A.
 */
export interface ResourceValueDefinition {
  /** Human-readable label, shown as the submenu entry. Defaults to the key. */
  label?: string;
  /**
   * Explicit slot(s) this value fills — same grammar and precedence as a
   * resource's own {@link DynamicResourceDefinition.for}.
   */
  for?: string | readonly string[];
}

/** The values `create()` receives, one per entry in {@link ResourceNeeds}. */
export type ResolvedNeeds<N extends ResourceNeeds> = {
  [K in keyof N]: N[K] extends Resource<infer T> ? T : never;
};

/**
 * A resource whose value is produced by running code, resolved via
 * `create()`. See {@link resource} for the narrative.
 */
export interface DynamicResourceDefinition<
  T,
  N extends ResourceNeeds = Record<string, never>,
> {
  /** Human-readable label shown on the chip in the execute panel. */
  label?: string;
  /**
   * How long the created value lives.
   *
   * `'run'` (the default) creates a fresh value per execution and disposes it
   * when the run settles. `'server'` creates once and memoizes, disposing at
   * shutdown or when the defining module changes — the right choice when
   * `create()` is expensive (standing up a worker runtime, say).
   *
   * A `'run'`-scoped resource may depend on a `'server'`-scoped one, but not
   * the reverse: a long-lived value must not close over a per-run one. The
   * registry rejects that at load time.
   */
  scope?: ResourceScope;
  /**
   * Other resources this one needs, resolved first and passed to `create`.
   * See {@link ResourceNeeds}.
   */
  needs?: N;
  /**
   * Explicit slot to fill, as a dotted path optionally prefixed by a prompt
   * name — `'orchestrate.taskId'`, `'toolsContext.list_tasks.db'`. An escape
   * hatch that always works, tried before type and name matching.
   */
  for?: string | readonly string[];
  /**
   * Display path of the group this resource belongs to, `/`-separated for
   * nesting (`'Tasks'`, `'Tasks/Regressions'`). Purely how the picker's menu
   * is drawn — never part of the resource's URI, so renaming a group
   * invalidates no saved selection and no past trace. Absent means top
   * level. See `specs/resource-hierarchy.md` §B.
   */
  group?: string;
  /**
   * Named values read off the produced value, each selectable on its own in
   * the picker alongside the resource itself. See
   * {@link ResourceValueDefinition} and `specs/resource-hierarchy.md` §A.
   */
  values?: Partial<Record<keyof T & string, string | ResourceValueDefinition>>;
  /** Produces the value. See {@link ResourceInstance}. */
  create(
    needs: ResolvedNeeds<N>,
  ): ResourceInstance<T> | Promise<ResourceInstance<T>>;
}

/**
 * A resource whose value is already known — a literal rather than something
 * `create()` computes. Scoped as `'server'` always (see
 * {@link DynamicResourceDefinition.scope}): there is nothing to create per
 * run, so the same value is handed out for the life of the process.
 */
export interface StaticResourceDefinition<T> {
  /** Human-readable label shown on the chip in the execute panel. */
  label?: string;
  scope?: undefined;
  /**
   * Explicit slot to fill, as a dotted path optionally prefixed by a prompt
   * name — `'orchestrate.taskId'`, `'toolsContext.list_tasks.db'`. An escape
   * hatch that always works, tried before type and name matching.
   */
  for?: string | readonly string[];
  /**
   * Display path of the group this resource belongs to, `/`-separated for
   * nesting (`'Tasks'`, `'Tasks/Regressions'`). Purely how the picker's menu
   * is drawn — never part of the resource's URI. Absent means top level. See
   * `specs/resource-hierarchy.md` §B.
   */
  group?: string;
  /**
   * Named values read off {@link value}, each selectable on its own in the
   * picker alongside the resource itself. See {@link ResourceValueDefinition}
   * and `specs/resource-hierarchy.md` §A.
   */
  values?: Partial<Record<keyof T & string, string | ResourceValueDefinition>>;
  /** The value itself. */
  value: T;
}

/** What {@link resource} is given. See {@link resource} for the narrative. */
export type ResourceDefinition<
  T,
  N extends ResourceNeeds = Record<string, never>,
> = DynamicResourceDefinition<T, N> | StaticResourceDefinition<T>;

/**
 * A named value produced by code at run time, in-process, with a lifecycle.
 *
 * Returned by {@link resource}; see it for what a resource is and how one is
 * written.
 *
 * @typeParam T - The type of value this resource produces.
 */
export type Resource<T> = ResourceDefinition<T, any> & {
  /** @internal Identifies this object to the playground-module loader. */
  readonly [RESOURCE_TAG]: true;
};

/**
 * Declares a value that only running code can produce, so the playground can
 * offer it as an input to a prompt.
 *
 * That — not "is it JSON-serializable" — is the defining property. A resource
 * may well resolve to a plain string (the id of a task it just inserted); what
 * makes it a resource is that no form could have produced it. A live database
 * handle is the limiting case: it cannot be typed in, and it cannot be sent
 * over the wire either, so the panel offers the *reference* and the value is
 * created server-side at run time.
 *
 * Resources live in **playground modules** — `*.playground.ts` beside a prompt
 * file (in scope for prompts in that directory), or any `.ts` under
 * `.evalution/playground/` (in scope for the whole workspace). The export name
 * is the resource's key. Such code runs in the server process with full
 * filesystem and network access, which is the trust level the prompt file
 * already has.
 *
 * The resource's **type is inferred from what `create` returns** — there is no
 * type string to keep in sync with a rename. Pin it with a type argument when
 * inference widens past the named type a slot is declared with: `makeNanoId`
 * below returns `` `tsk_${string}` ``, which is the same type as `TaskId`
 * spelled differently.
 *
 * @example A live handle, created once per server because it is expensive.
 * ```ts
 * // .evalution/playground/db.ts
 * import { resource } from 'evalution';
 *
 * export const db = resource({
 *   label: 'Local D1 (.wrangler state)',
 *   scope: 'server',
 *   async create() {
 *     const mf = new Miniflare({ ... });
 *     return { value: makeDb(await mf.getD1Database('APP_DB')), dispose: () => mf.dispose() };
 *   },
 * });
 * ```
 *
 * @example A per-run value that depends on the handle above.
 * ```ts
 * // src/agents/odin/odin.playground.ts
 * import { resource } from 'evalution';
 * import { db } from '../../../.evalution/playground/db.js';
 *
 * export const seededRootTask = resource<TaskId>({
 *   label: 'Freshly seeded root task',
 *   needs: { db },
 *   async create({ db }) {
 *     const id = makeNanoId('tsk_');
 *     await db.insert(tasks).values({ id });
 *     return { value: id, receipt: id };
 *   },
 * });
 * ```
 *
 * @param definition - See {@link ResourceDefinition}.
 * @returns The resource, to be exported under the name it should be known by.
 */
// Overloaded rather than typed with the `ResourceDefinition<T, N>` union
// directly: a caller's `export const db = resource({ create: ... })` needs
// `create` still present on `db`'s own inferred type, not erased behind
// `Resource<T>`. The checker-based slot matcher reads a resource's type back
// off its own declaration (`db["create"]`'s return, or `apiKey["value"]`
// directly) — see `resourceTypeExpression` in `file-prompt-provider.ts` — and
// that indexed access only type-checks against the concrete shape, not a
// union where the property is missing from one branch.
export function resource<T>(
  definition: StaticResourceDefinition<T>,
): StaticResourceDefinition<T> & { readonly [RESOURCE_TAG]: true };
export function resource<
  T,
  const N extends ResourceNeeds = Record<string, never>,
>(
  definition: DynamicResourceDefinition<T, N>,
): DynamicResourceDefinition<T, N> & { readonly [RESOURCE_TAG]: true };
export function resource(definition: ResourceDefinition<any, any>): unknown {
  return { ...definition, [RESOURCE_TAG]: true };
}

/** Whether `value` was produced by {@link resource}. */
export function isResource(value: unknown): value is Resource<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[RESOURCE_TAG] === true
  );
}
