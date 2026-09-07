// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalFileProvider } from "../../file-provider-local.ts";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { resolveExecutionInputs } from "../execution-inputs.ts";
import { resource } from "./resource.ts";
import { ResourceRegistry } from "./resource-registry.ts";

const ROOT = "/proj";
const p = (...segments: string[]) => path.join(ROOT, ...segments);

/**
 * A `file:` URL for the real `resource()` helper.
 *
 * {@link MemoryFileProvider} imports through a `data:` URL, which cannot
 * resolve the bare `"evalution"` specifier a real playground module would use.
 * An absolute URL resolves fine, so fixtures exercise the actual helper rather
 * than a hand-rolled stand-in of its tag.
 */
const HELPER = pathToFileURL(
  path.join(import.meta.dirname, "resource.ts"),
).href;

const importHelper = `import { resource } from ${JSON.stringify(HELPER)};`;

function registry(files: Record<string, string>) {
  const fileProvider = new MemoryFileProvider(files);
  return {
    fileProvider,
    registry: new ResourceRegistry({ fileProvider, rootDir: ROOT }),
  };
}

describe("playground module discovery", () => {
  it("scopes a *.playground.ts to prompts in its own directory", async () => {
    const { registry: reg } = registry({
      [p("a/tools.playground.ts")]: `${importHelper}
        export const alpha = resource({ create: () => ({ value: 1 }) });`,
      [p("b/other.playground.ts")]: `${importHelper}
        export const beta = resource({ create: () => ({ value: 2 }) });`,
    });

    // Directory membership, not a name pairing — so one module serves every
    // prompt file beside it, and none of the ones elsewhere.
    const forA = await reg.inScopeFor(p("a/first.prompt.ts"));
    const forA2 = await reg.inScopeFor(p("a/second.prompt.ts"));
    const forB = await reg.inScopeFor(p("b/x.prompt.ts"));

    expect(forA.map(r => r.key)).toEqual(["alpha"]);
    expect(forA2.map(r => r.key)).toEqual(["alpha"]);
    expect(forB.map(r => r.key)).toEqual(["beta"]);
  });

  it("merges several files under .evalution/playground into one project scope", async () => {
    const { registry: reg } = registry({
      [p(".evalution/playground/db.ts")]: `${importHelper}
        export const db = resource({ create: () => ({ value: "db" }) });`,
      [p(".evalution/playground/nested/http.ts")]: `${importHelper}
        export const http = resource({ create: () => ({ value: "http" }) });`,
    });

    const anywhere = await reg.inScopeFor(p("deep/nested/x.prompt.ts"));
    expect(anywhere.map(r => r.key).sort()).toEqual(["db", "http"]);
  });

  it("ignores exports it does not recognise", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const helper = (n) => n + 1;
        export const CONSTANT = 42;
        export default { not: "a resource" };
        export const real = resource({ create: () => ({ value: 1 }) });`,
    });

    // The export surface is open: only tagged values are collected, and
    // everything else is a colocated helper rather than an error.
    expect((await reg.all()).map(r => r.key)).toEqual(["real"]);
  });

  it("mints rootDir-relative uris so a saved selection survives a move", async () => {
    const source = `${importHelper}
      export const db = resource({ create: () => ({ value: 1 }) });`;

    const here = new ResourceRegistry({
      fileProvider: new MemoryFileProvider({
        [p(".evalution/playground/db.ts")]: source,
      }),
      rootDir: ROOT,
    });
    const elsewhere = new ResourceRegistry({
      fileProvider: new MemoryFileProvider({
        "/somewhere/else/.evalution/playground/db.ts": source,
      }),
      rootDir: "/somewhere/else",
    });

    expect((await here.all())[0].uri).toBe(".evalution/playground/db.ts#db");
    expect((await elsewhere.all())[0].uri).toBe(
      ".evalution/playground/db.ts#db",
    );
  });

  it("keeps the other modules usable when one throws at import time", async () => {
    const { registry: reg } = registry({
      [p("broken.playground.ts")]: `throw new Error("boom");`,
      [p("fine.playground.ts")]: `${importHelper}
        export const ok = resource({ create: () => ({ value: 1 }) });`,
    });

    // Playground modules are imported eagerly, so one that throws must degrade
    // to "this module's resources are unavailable" rather than take the rest
    // — or the server — with it.
    expect((await reg.all()).map(r => r.key)).toEqual(["ok"]);
    const errors = await reg.errors();
    expect(errors).toHaveLength(1);
    expect(errors[0].modulePath).toBe(p("broken.playground.ts"));
    expect(errors[0].message).toContain("boom");
  });
});

describe("resource lifecycle", () => {
  it("resolves `needs` by identity and passes the dependency's value in", async () => {
    const { registry: reg } = registry({
      [p("a/seed.playground.ts")]: `${importHelper}
        const db = resource({ create: () => ({ value: { tag: "the-db" } }) });
        export const seeded = resource({
          needs: { db },
          create: ({ db }) => ({ value: "seeded-with-" + db.tag }),
        });
        export { db };`,
    });

    // `needs` takes the resource *values*, not string keys, so the registry
    // resolves them by identity — which is what makes the dependency typed at
    // the call site and immune to key collisions across playground files.
    const lease = reg.lease();
    expect(await lease.acquire("a/seed.playground.ts#seeded")).toBe(
      "seeded-with-the-db",
    );
    await lease.release();
  });

  it("resolves a dependency that lives in another playground module", async () => {
    // Real filesystem: a cross-module `needs` is a genuine dynamic-import
    // resolution, which the in-memory provider's `data:` URLs cannot do — and
    // importing the project-scoped db from a prompt-scoped module is the
    // motivating idiom, so it is worth exercising for real.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evalution-pg-"));
    try {
      await fs.mkdir(path.join(dir, ".evalution/playground"), {
        recursive: true,
      });
      await fs.mkdir(path.join(dir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".evalution/playground/db.ts"),
        `${importHelper}
         export const db = resource({ create: () => ({ value: { tag: "real-db" } }) });`,
      );
      await fs.writeFile(
        path.join(dir, "agents/odin.playground.ts"),
        `${importHelper}
         import { db } from "../.evalution/playground/db.ts";
         export const seededRootTask = resource({
           needs: { db },
           create: ({ db }) => ({ value: "tsk_from_" + db.tag }),
         });`,
      );

      const reg = new ResourceRegistry({
        fileProvider: new LocalFileProvider(),
        rootDir: dir,
      });

      const lease = reg.lease();
      expect(
        await lease.acquire("agents/odin.playground.ts#seededRootTask"),
      ).toBe("tsk_from_real-db");
      await lease.release();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a run-scoped resource once per lease and disposes it once", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        globalThis.__creates = 0;
        globalThis.__disposes = 0;
        export const thing = resource({
          create: () => {
            globalThis.__creates++;
            return { value: ++globalThis.__creates, dispose: () => { globalThis.__disposes++; } };
          },
        });`,
    });

    const lease = reg.lease();
    const first = await lease.acquire("x.playground.ts#thing");
    const second = await lease.acquire("x.playground.ts#thing");
    // One value per run, however many slots reference it — which is why
    // resolution takes every input together.
    expect(second).toBe(first);

    await lease.release();
    await lease.release(); // idempotent
    expect((globalThis as any).__disposes).toBe(1);
  });

  it("memoizes a server-scoped resource across runs, and disposes it on invalidate", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        globalThis.__serverDisposes = 0;
        let n = 0;
        export const thing = resource({
          scope: "server",
          create: () => ({ value: ++n, dispose: () => { globalThis.__serverDisposes++; } }),
        });`,
    });

    const first = reg.lease();
    const a = await first.acquire("x.playground.ts#thing");
    await first.release();

    const second = reg.lease();
    const b = await second.acquire("x.playground.ts#thing");
    await second.release();

    // Releasing a lease must not touch a value that outlives the run.
    expect(b).toBe(a);
    expect((globalThis as any).__serverDisposes).toBe(0);

    await reg.invalidate();
    expect((globalThis as any).__serverDisposes).toBe(1);
  });

  it("rejects a dependency cycle at resolution rather than overflowing", async () => {
    const { registry: reg } = registry({
      [p("cycle.playground.ts")]: `${importHelper}
        const a = { label: "a", create: () => ({ value: 1 }) };
        const b = { label: "b", needs: {}, create: () => ({ value: 2 }) };
        const A = resource(a);
        const B = resource(b);
        A.needs = { B };
        B.needs = { A };
        export { A, B };`,
    });

    const lease = reg.lease();
    await expect(lease.acquire("cycle.playground.ts#A")).rejects.toThrow(
      /cycle/i,
    );
  });

  it("refuses a server-scoped resource that depends on a run-scoped one", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const perRun = resource({ create: () => ({ value: 1 }) });
        export const longLived = resource({
          scope: "server",
          needs: { perRun },
          create: () => ({ value: 2 }),
        });`,
    });

    // A value that outlives the run must not close over one that doesn't.
    const lease = reg.lease();
    await expect(lease.acquire("x.playground.ts#longLived")).rejects.toThrow(
      /run-scoped/,
    );
  });

  it("collects receipts so a trace can show what a resource produced", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const seeded = resource({
          create: () => ({ value: "tsk_abc123", receipt: "tsk_abc123" }),
        });`,
    });

    const lease = reg.lease();
    await lease.acquire("x.playground.ts#seeded");
    expect(lease.receipts()).toEqual({
      "x.playground.ts#seeded": "tsk_abc123",
    });
    await lease.release();
  });
});

describe("static value resources", () => {
  it("resolves a `value` resource without a create()", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const apiKey = resource({ value: "secret" });`,
    });

    const lease = reg.lease();
    expect(await lease.acquire("x.playground.ts#apiKey")).toBe("secret");
    await lease.release();
  });

  it("defaults an unscoped value resource to 'server' in the panel description", async () => {
    // A literal has nothing to create per run, so it defaults to 'server' —
    // memoized for the life of the process — the same as `instantiate()`
    // treats it. `describe()` must agree, or the execute panel's chip lies
    // about whether the value is recreated on every run.
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const apiKey = resource({ value: "secret" });`,
    });

    const [described] = reg.describe(await reg.all());
    expect(described.scope).toBe("server");
  });

  it("lets a server-scoped resource depend on a value resource", async () => {
    // A value resource defaults to 'server' scope (see above), so it must
    // pass the "server can't depend on run-scoped" check just like an
    // explicitly server-scoped dependency would.
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const apiKey = resource({ value: "secret" });
        export const client = resource({
          scope: "server",
          needs: { apiKey },
          create: ({ apiKey }) => ({ value: "client-" + apiKey }),
        });`,
    });

    const lease = reg.lease();
    expect(await lease.acquire("x.playground.ts#client")).toBe("client-secret");
    await lease.release();
  });

  it("does not call dispose on a value resource when a lease releases", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const apiKey = resource({ value: "secret" });`,
    });

    const lease = reg.lease();
    await lease.acquire("x.playground.ts#apiKey");
    // A literal has no lifecycle to tear down; releasing must not throw
    // trying to call a `dispose` it never had.
    await expect(lease.release()).resolves.toBeUndefined();
  });
});

describe("value previews in the panel description", () => {
  it("ships a static `value` resource's value, since it's known before any run", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const workspace = resource({
          value: { id: "ws_1", tags: ["a", "b"] },
        });`,
    });

    const [described] = reg.describe(await reg.all());
    expect(described.value).toEqual({ id: "ws_1", tags: ["a", "b"] });
  });

  it("ships a server-scoped resource's value only after it's actually been created", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const config = resource({
          scope: "server",
          create: () => ({ value: { host: "localhost" } }),
        });`,
    });

    // Nothing to peek yet — showing a value here would mean either creating
    // it just to preview it (defeating the point of lazy 'server' scope) or
    // showing a stale one from nowhere.
    const [beforeRun] = reg.describe(await reg.all());
    expect(beforeRun.value).toBeUndefined();

    const lease = reg.lease();
    await lease.acquire("x.playground.ts#config");
    await lease.release();

    const [afterRun] = reg.describe(await reg.all());
    expect(afterRun.value).toEqual({ host: "localhost" });
  });

  it("never ships a run-scoped resource's value, even after acquiring it", async () => {
    // A run-scoped instance is disposed with the lease that created it — the
    // registry itself never memoizes one, so there's nothing later to peek.
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const seeded = resource({
          create: () => ({ value: "tsk_1" }),
        });`,
    });

    const lease = reg.lease();
    await lease.acquire("x.playground.ts#seeded");
    await lease.release();

    const [described] = reg.describe(await reg.all());
    expect(described.value).toBeUndefined();
  });

  it("does not ship a value that isn't plain JSON data, even though it's known", async () => {
    // A live handle survives `JSON.stringify` (it just silently drops the
    // methods that make it a handle) — that's exactly the misleading preview
    // this must not produce.
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        class FakeDb { query() {} }
        export const db = resource({ value: new FakeDb() });`,
    });

    const [described] = reg.describe(await reg.all());
    expect(described.value).toBeUndefined();
  });

  it("ships a detached snapshot, not the registry's own live object", async () => {
    const { registry: reg } = registry({
      [p("x.playground.ts")]: `${importHelper}
        export const workspace = resource({ value: { tags: ["a"] } });`,
    });

    const [described] = reg.describe(await reg.all());
    (described.value as { tags: string[] }).tags.push("mutated");

    const [again] = reg.describe(await reg.all());
    expect(again.value).toEqual({ tags: ["a"] });
  });
});

describe("combined execute inputs (specs/combined-execute-inputs.md §C.2)", () => {
  it("creates a run-scoped resource once even when four member paths reference it", async () => {
    const { registry: reg } = registry({
      [p("db.playground.ts")]: `${importHelper}
        globalThis.__creates = 0;
        globalThis.__disposes = 0;
        export const db = resource({
          create: () => {
            globalThis.__creates++;
            return { value: { conn: globalThis.__creates }, dispose: () => { globalThis.__disposes++; } };
          },
        });`,
    });

    const lease = reg.lease();
    const uri = "db.playground.ts#db";
    // The shape combined mode expands `db` into: one `resource` node per tool
    // member, all naming the same uri — exactly what `ResourceRegistry.lease`
    // is supposed to memoize by identity rather than by how many times it's
    // referenced.
    const resourceNode = { kind: "resource" as const, uri };
    const executeInputs = {
      toolsContext: {
        kind: "object" as const,
        properties: {
          list_tasks: {
            kind: "object" as const,
            properties: { db: resourceNode },
          },
          create_task: {
            kind: "object" as const,
            properties: { db: resourceNode },
          },
          update_task: {
            kind: "object" as const,
            properties: { db: resourceNode },
          },
          post_message: {
            kind: "object" as const,
            properties: { db: resourceNode },
          },
        },
      },
    };

    const { executeValues } = await resolveExecutionInputs(
      { executeInputs },
      resourceUri => lease.acquire(resourceUri),
    );

    const ctx = executeValues.toolsContext as Record<string, { db: unknown }>;
    expect(ctx.list_tasks.db).toBe(ctx.create_task.db);
    expect(ctx.update_task.db).toBe(ctx.post_message.db);
    expect(ctx.list_tasks.db).toBe(ctx.post_message.db);
    expect((globalThis as any).__creates).toBe(1);

    await lease.release();
    expect((globalThis as any).__disposes).toBe(1);
  });
});

/**
 * A provider that models Node's module cache, which neither of the providers
 * above does.
 *
 * A cache-busted import (`fresh`) re-evaluates a module and produces *new*
 * resource objects; a plain one hands back the first evaluation. A module's
 * own `import` of a sibling carries no cache-busting query, so it always binds
 * the plain instance — which means the object arriving through `needs` is not
 * the object discovery registered. Vitest's module runner collapses the two
 * into one instance, so the condition has to be modelled to be tested at all.
 */
function duplicatingProvider(
  modules: Record<
    string,
    (deps: Record<string, any>, fresh: boolean) => Record<string, any>
  >,
) {
  const plain = new Map<string, Record<string, any>>();

  // A module's dependencies are always the plain instances, whether the module
  // itself was re-evaluated or not. Resolved on access, the way an `import`
  // is, so a module that imports nothing pulls in nothing.
  const deps = new Proxy({} as Record<string, any>, {
    get: (_, key) => load(String(key), false),
  });

  const load = (filePath: string, fresh: boolean): Record<string, any> => {
    if (!fresh && plain.has(filePath)) return plain.get(filePath)!;
    const namespace = modules[filePath](deps, fresh);
    if (!fresh) plain.set(filePath, namespace);
    return namespace;
  };

  return {
    async *glob() {
      yield* Object.keys(modules);
    },
    async import(filePath: string, { fresh = false } = {}) {
      return load(filePath, fresh);
    },
  } as unknown as MemoryFileProvider;
}

describe("duplicate module instances", () => {
  /** A `db` whose value says which evaluation of its module produced it. */
  const dbModule = (_deps: Record<string, any>, fresh: boolean) => {
    let created = 0;
    return {
      db: resource({
        create: () => ({
          value: { tag: fresh ? "fresh" : "stale", created: ++created },
        }),
      }),
    };
  };

  it("resolves a `needs` dependency that arrives as a different module instance", async () => {
    const reg = new ResourceRegistry({
      fileProvider: duplicatingProvider({
        [p("db.playground.ts")]: dbModule,
        [p("odin.playground.ts")]: deps => ({
          seeded: resource({
            needs: { db: deps[p("db.playground.ts")].db },
            create: ({ db }: any) => ({ value: `tsk_from_${db.tag}` }),
          }),
        }),
      }),
      rootDir: ROOT,
    });

    const lease = reg.lease();
    // The dependency object came from the plain instance while the registry
    // registered the freshly-evaluated one. Resolving by identity alone would
    // fail here with "not exported from any playground module".
    expect(await lease.acquire("odin.playground.ts#seeded")).toBe(
      // …and the value has to come from the re-evaluated module: the instance
      // the dependency points at is a key, never something to create from, or
      // an edit to the resource would never take effect.
      "tsk_from_fresh",
    );
    await lease.release();
  });

  it("creates one instance per run whichever way the resource is reached", async () => {
    const reg = new ResourceRegistry({
      fileProvider: duplicatingProvider({
        [p("db.playground.ts")]: dbModule,
        [p("odin.playground.ts")]: deps => ({
          seeded: resource({
            needs: { db: deps[p("db.playground.ts")].db },
            create: ({ db }: any) => ({ value: `tsk_${db.tag}_${db.created}` }),
          }),
        }),
      }),
      rootDir: ROOT,
    });

    const lease = reg.lease();
    // Picked directly for one slot and pulled in as a dependency for another:
    // one `create()`, or the seeded row lands in a different database than the
    // one the tools query.
    const direct: any = await lease.acquire("db.playground.ts#db");
    const viaNeeds = await lease.acquire("odin.playground.ts#seeded");
    expect(direct).toEqual({ tag: "fresh", created: 1 });
    expect(viaNeeds).toBe("tsk_fresh_1");
    await lease.release();
  });
});
