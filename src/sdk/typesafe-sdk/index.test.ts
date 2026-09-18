// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultCall,
  findFactory,
  type PropValue,
  setCallArgument,
  type ValueCatalog,
} from "ts-proppy";
import { describe, expect, it } from "vitest";
import { MemoryFileProvider } from "../../file-provider-memory.ts";
import { FilePromptProvider } from "../../prompt/file/file-prompt-provider.ts";
import { isEditable } from "../../shared/helpers.ts";
import type { NormalizedQuestionsPrompt } from "../../shared/types.ts";
import { TYPESAFE_FALLBACK } from "./fallback.ts";
import { TypeSafeSDK } from "./index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../../prompt/file/ts/__fixtures__");

/**
 * A provider over in-memory copies of the fixtures. Rooted at the real
 * fixtures directory, so project probes resolve against the installed SDK.
 */
function providerFor(files: string[], rootDir = fixturesDir) {
  const fileProvider = new MemoryFileProvider(
    Object.fromEntries(
      files.map(name => [
        path.join(rootDir, name),
        readFileSync(path.join(fixturesDir, name), "utf8"),
      ]),
    ),
  );
  const provider = new FilePromptProvider({
    rootDir,
    fileProvider,
    includePatterns: files,
    playgroundIncludePatterns: [],
    sdk: new TypeSafeSDK({ client: { apiKey: "test", fetch: offline } }),
  });
  return { provider, fileProvider };
}

async function offline(): Promise<Response> {
  throw new Error("offline");
}

async function prompt(
  provider: FilePromptProvider,
  name: string,
): Promise<NormalizedQuestionsPrompt> {
  const found = await provider.getPrompt(`typesafe-triage.prompt.ts#${name}`);
  if (found?.style !== "questions")
    throw new Error(`no questions prompt ${name}`);
  return found;
}

const catalogOf = (p: NormalizedQuestionsPrompt): ValueCatalog[] => {
  const type = p.questions.def.type;
  return type.kind === "record" ? (type.value.catalogs ?? []) : [];
};

const questionsOf = (p: NormalizedQuestionsPrompt) => {
  const value = p.questions.value;
  if (value?.kind !== "object") throw new Error("questions are not an object");
  return value.properties;
};

describe("TypeSafeSDK.normalizePrompt", () => {
  const { provider } = providerFor(["typesafe-triage.prompt.ts"]);

  it("normalizes factory-call questions and a state reference", async () => {
    const p = await prompt(provider, "triage");
    expect(p.style).toBe("questions");
    expect(p.state.value).toEqual({
      kind: "object",
      properties: { ticket: { kind: "reference", path: ["ticket"] } },
    });
    const questions = questionsOf(p);
    expect(Object.keys(questions)).toEqual([
      "refund_requested",
      "team",
      "frustration",
    ]);
    const catalogs = catalogOf(p);
    for (const [id, callee] of [
      ["refund_requested", "noul"],
      ["team", "choice"],
      ["frustration", "score"],
    ]) {
      expect(findFactory(catalogs, questions[id])?.factory.def.name).toBe(
        callee,
      );
    }
  });

  it("offers every question factory in the installed SDK, bound to its import", async () => {
    const p = await prompt(provider, "triage");
    const groups = catalogOf(p)[0].groups;
    expect(groups.map(g => g.label).sort()).toEqual([
      "Choice",
      "Score",
      "Yes / no",
    ]);
    expect(groups.find(g => g.label === "Choice")?.factory?.binding).toEqual({
      kind: "import",
      spec: { name: "choice", from: "@typesafe-ai/sdk" },
    });
  });

  it("normalizes object-form questions against the SDK's question union", async () => {
    const p = await prompt(provider, "objects");
    expect(p.model).toEqual({ kind: "primitive", value: "jev-latest" });
    expect(p.state.value).toEqual({
      kind: "reference",
      path: ["ticket", "body"],
    });
    const questions = questionsOf(p);
    expect(questions.tone).toMatchObject({
      kind: "object",
      properties: { type: { kind: "primitive", value: "choice" } },
    });
    const type = p.questions.def.type;
    expect(type.kind === "record" && type.value.type.kind).toBe("union");
  });

  it("leaves questions built by other code uneditable", async () => {
    const p = await prompt(provider, "computed");
    expect(p.questions.value).toMatchObject({
      kind: "functionCall",
      callee: "buildQuestions",
    });
    // A call to a local helper has no binding the editor could write back,
    // and isn't one of the SDK's question factories either.
    expect(isEditable(p.questions.value!)).toBe(false);
    expect(findFactory(catalogOf(p), p.questions.value)).toBeUndefined();
  });

  it("reads the state and questions types from the installed SDK", async () => {
    const p = await prompt(provider, "triage");
    expect(p.state.def.type).toMatchObject({ kind: "union" });
    expect(p.questions.def.type).toMatchObject({ kind: "record" });
    expect(p.modelParameters).toEqual([]);
  });

  it("falls back to the snapshot when the SDK can't be resolved", async () => {
    const { provider: offlineProvider } = providerFor(
      ["typesafe-triage.prompt.ts"],
      "/virtual",
    );
    const p = (await offlineProvider.getPrompt(
      "typesafe-triage.prompt.ts#triage",
    )) as NormalizedQuestionsPrompt;
    const snapshot = TYPESAFE_FALLBACK.state;
    expect(p.state.def.type).toEqual(
      snapshot && !Array.isArray(snapshot) ? snapshot.type : undefined,
    );
    expect(
      catalogOf(p)[0]
        .groups.map(g => g.factory?.def.name)
        .sort(),
    ).toEqual(["choice", "noul", "score"]);
  });
});

describe("TypeSafeSDK edits", () => {
  it("adds a choice question — importing choice — and a state reference", async () => {
    const { provider, fileProvider } = providerFor(["typesafe-edit.prompt.ts"]);
    const before = (await provider.getPrompt(
      "typesafe-edit.prompt.ts#triage",
    )) as NormalizedQuestionsPrompt;
    const choiceFactory = catalogOf(before)[0].groups.find(
      g => g.factory?.def.name === "choice",
    )!.factory!;
    const params =
      choiceFactory.def.type.kind === "function"
        ? choiceFactory.def.type.parameters
        : [];
    let team = defaultCall(choiceFactory);
    team = setCallArgument(team, params, 0, {
      kind: "template",
      value: ["Which team handles ", { expr: "product" }, "?"],
    });
    team = setCallArgument(team, params, 1, {
      kind: "object",
      properties: {
        billing: { kind: "primitive", value: "Payments" },
        technical: { kind: "primitive", value: null },
      },
    });

    const questions: PropValue = {
      kind: "object",
      properties: { ...questionsOf(before), team },
    };
    const after = (await provider.updatePromptProperties(
      "typesafe-edit.prompt.ts#triage",
      {
        style: "questions",
        state: {
          kind: "object",
          properties: { ticket: { kind: "reference", path: ["ticket"] } },
        },
        questions,
      },
    )) as NormalizedQuestionsPrompt;

    const source = await fileProvider.readFile(
      path.join(fixturesDir, "typesafe-edit.prompt.ts"),
    );
    expect(source).toMatch(
      /import \{ noul, choice \} from "@typesafe-ai\/sdk"/,
    );
    expect(source).toContain("state: { ticket }");
    expect(source).toContain(
      'team: choice(`Which team handles ${product}?`, { billing: "Payments", technical: null })',
    );
    expect(
      findFactory(catalogOf(after), questionsOf(after).team),
    ).toBeDefined();
    expect(after.state.value).toEqual({
      kind: "object",
      properties: { ticket: { kind: "reference", path: ["ticket"] } },
    });
  });

  it("refuses updates written for a chat prompt", () => {
    expect(() =>
      new TypeSafeSDK().denormalizeUpdates({ style: "chat", system: null }),
    ).toThrow(/"chat" updates to a "questions" prompt/);
  });
});

describe("TypeSafeSDK.getModelDefinition", () => {
  it("falls back to the default model when models can't be listed", async () => {
    const sdk = new TypeSafeSDK({ client: { apiKey: "test", fetch: offline } });
    const def = await sdk.getModelDefinition({});
    expect(def.defaultValue).toEqual({
      kind: "primitive",
      value: "jev-latest",
    });
    expect(def.catalogs?.[0].groups[0].presets).toEqual([
      {
        label: "jev-latest",
        value: { kind: "primitive", value: "jev-latest" },
      },
    ]);
    expect(def.catalogs?.[0].literal).toBe(true);
  });

  it("offers the account's models as presets", async () => {
    const listing = async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "jev-latest", description: "", release_date: "" },
            { name: "jev-2", description: "", release_date: "" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const sdk = new TypeSafeSDK({
      client: { apiKey: "test", fetch: listing, defaultModel: "jev-2" },
    });
    const def = await sdk.getModelDefinition({});
    expect(def.catalogs?.[0].groups[0].presets?.map(p => p.label)).toEqual([
      "jev-latest",
      "jev-2",
    ]);
    expect(def.defaultValue).toEqual({ kind: "primitive", value: "jev-2" });
  });

  it("lists the models once the environment is fixed, not just at startup", async () => {
    let online = false;
    const fetch = async () => {
      if (!online) throw new Error("offline");
      return new Response(
        JSON.stringify({
          models: [{ name: "jev-2", description: "", release_date: "" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const sdk = new TypeSafeSDK({ client: { apiKey: "test", fetch } });

    const before = await sdk.getModelDefinition({});
    expect(before.catalogs?.[0].groups[0].presets?.map(p => p.label)).toEqual([
      "jev-latest",
    ]);

    // A transient failure shouldn't pin the picker to the default model for
    // the lifetime of the process.
    online = true;
    const after = await sdk.getModelDefinition({});
    expect(after.catalogs?.[0].groups[0].presets?.map(p => p.label)).toEqual([
      "jev-2",
    ]);
  });
});
