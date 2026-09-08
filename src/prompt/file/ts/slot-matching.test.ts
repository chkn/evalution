// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createPromptProgram } from "./prompt-program.ts";
import { collectSlotTypes } from "./slot-matching.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Never written to disk: `createPromptProgram` takes source as an overlay, and
// this file's `source` has no imports for a real path to resolve.
const virtualFile = path.join(
  __dirname,
  "__fixtures__",
  "slot-matching.virtual.ts",
);

/** The type of `export const root: ...` in `source`, resolved via a real `ts.Program`. */
function rootType(source: string): {
  type: ts.Type;
  typeChecker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const built = createPromptProgram(new Map([[virtualFile, source]]));
  if (!built) throw new Error("createPromptProgram returned nothing");
  const { typeChecker, getSourceFile } = built;
  const sourceFile = getSourceFile(virtualFile)!;

  let declName: ts.Identifier | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "root"
    ) {
      declName = node.name;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!declName) throw new Error("`root` not declared in fixture source");

  return {
    type: typeChecker.getTypeAtLocation(declName),
    typeChecker,
    sourceFile,
  };
}

describe("collectSlotTypes", () => {
  it("stops at a branded-string leaf instead of expanding it into String.prototype", () => {
    const { type, typeChecker, sourceFile } = rootType(`
      type WorkspaceId = \`ws_\${string}\`;
      export const root: { workspaceId: WorkspaceId } = null as any;
    `);

    const slots = collectSlotTypes(
      new Map([["root", type]]),
      typeChecker,
      sourceFile,
    );

    expect(slots.has("root.workspaceId")).toBe(true);
    // Not `.charAt`, `.slice`, `.length`, … — the template-literal type
    // structurally carries the whole `String` interface, but it's a leaf.
    expect([...slots.keys()].some(k => k.startsWith("root.workspaceId."))).toBe(
      false,
    );
  });

  it("stops at a class-instance handle instead of expanding its methods", () => {
    const { type, typeChecker, sourceFile } = rootType(`
      declare class Handle {
        readonly url: string;
        private connection: unknown;
        query(sql: string): Promise<unknown[]>;
      }
      type Db = Handle & { $client: { name: string } };
      export const root: { db: Db } = null as any;
    `);

    const slots = collectSlotTypes(
      new Map([["root", type]]),
      typeChecker,
      sourceFile,
    );

    expect(slots.has("root.db")).toBe(true);
    expect([...slots.keys()].some(k => k.startsWith("root.db."))).toBe(false);
  });

  it("still descends into a genuine nested object", () => {
    const { type, typeChecker, sourceFile } = rootType(`
      export const root: { nested: { field: string } } = null as any;
    `);

    const slots = collectSlotTypes(
      new Map([["root", type]]),
      typeChecker,
      sourceFile,
    );

    expect(slots.has("root.nested.field")).toBe(true);
  });

  it("reaches every fanned-out member's slot, not just the first few (regression: odin's toolsContext)", () => {
    // Shaped like `InferToolSetContext` fanning a per-tool context out by tool
    // name: several sibling members, each carrying a branded id and a
    // class-instance handle. Before branded/opaque leaves stopped the walk,
    // each member burned ~70 slots expanding them (a couple dozen handle
    // methods, ~50 String.prototype members off the branded id), and with
    // enough members that blew through `MAX_SLOTS` before the later ones'
    // fields were ever visited — losing a resource match on exactly those
    // fields, silently.
    const members = Array.from({ length: 12 }, (_, i) => `member${i}`);
    const { type, typeChecker, sourceFile } = rootType(`
      declare class Handle {
        readonly url: string;
        private connection: unknown;
        query(sql: string): Promise<unknown[]>;
      }
      type Db = Handle & { $client: { name: string } };
      type WorkspaceId = \`ws_\${string}\`;
      type Member = { db: Db; workspaceId: WorkspaceId };
      export const root: { ${members.map(m => `${m}: Member`).join("; ")} } = null as any;
    `);

    const slots = collectSlotTypes(
      new Map([["root", type]]),
      typeChecker,
      sourceFile,
    );

    for (const member of members) {
      expect(slots.has(`root.${member}.workspaceId`)).toBe(true);
      expect(slots.has(`root.${member}.db`)).toBe(true);
    }
    // A generous ceiling that still catches a regression back to expanding
    // primitive/opaque leaves (which would land in the thousands here).
    expect(slots.size).toBeLessThan(100);
  });
});
