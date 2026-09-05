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

/** The values `create()` receives, one per entry in {@link ResourceNeeds}. */
export type ResolvedNeeds<N extends ResourceNeeds> = {
  [K in keyof N]: N[K] extends Resource<infer T> ? T : never;
};

/** What {@link resource} is given. See {@link resource} for the narrative. */
export interface ResourceDefinition<
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
  /** Produces the value. See {@link ResourceInstance}. */
  create(
    needs: ResolvedNeeds<N>,
  ): ResourceInstance<T> | Promise<ResourceInstance<T>>;
}

/**
 * A named value produced by code at run time, in-process, with a lifecycle.
 *
 * Returned by {@link resource}; see it for what a resource is and how one is
 * written.
 *
 * @typeParam T - The type of value this resource produces.
 */
export interface Resource<T> extends ResourceDefinition<T, any> {
  /** @internal Identifies this object to the playground-module loader. */
  readonly [RESOURCE_TAG]: true;
}

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
export function resource<
  T,
  const N extends ResourceNeeds = Record<string, never>,
>(definition: ResourceDefinition<T, N>): Resource<T> {
  return { ...definition, [RESOURCE_TAG]: true } as Resource<T>;
}

/** Whether `value` was produced by {@link resource}. */
export function isResource(value: unknown): value is Resource<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[RESOURCE_TAG] === true
  );
}
