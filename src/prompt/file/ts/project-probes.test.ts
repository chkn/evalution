// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * Project probes and the `factories` probe kind. Real filesystem, deliberately:
 * these exercise package resolution against the repo's own `node_modules`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PropDefinition, ValueFactory } from "ts-proppy";
import { getOpenStringUnionInfo } from "ts-proppy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileProvider } from "../../../file-provider-local.ts";
import { VercelAISDK } from "../../../sdk/vercel-ai-sdk/index.ts";
import type { ParsedPrompt } from "../../../shared/types.ts";
import { FilePromptProvider } from "../file-prompt-provider.ts";
import type {
  ProbeResult,
  ProbeResults,
  TypeProbe,
} from "../prompt-file-type.ts";
import * as promptProgram from "./prompt-program.ts";
import { TSPromptFileType } from "./ts-prompt-file-type.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "__fixtures__");

const PROVIDERS: TypeProbe = {
  kind: "factories",
  name: "providers",
  modules: [
    "@ai-sdk/openai",
    "@ai-sdk/not-installed",
    "@ai-sdk/elevenlabs",
    "@ai-sdk/anthropic",
  ],
  produces: 'import("ai").LanguageModel',
};

async function resolveProject(probes: TypeProbe[]): Promise<ProbeResults> {
  const ft = new TSPromptFileType(new LocalFileProvider());
  const { project } = await ft.resolveTypes({
    project: { rootDir: fixturesDir, probes },
  });
  return project!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("factories probes", () => {
  it("discovers installed providers, bound to imports from their modules", async () => {
    const { providers } = await resolveProject([PROVIDERS]);
    const factories = providers as ValueFactory[];
    const names = factories.map(f => f.def.name);

    expect(names).toContain("openai");
    expect(names).toContain("anthropic");
    const openai = factories.find(f => f.def.name === "openai")!;
    expect(openai.binding).toEqual({
      kind: "import",
      spec: { name: "openai", from: "@ai-sdk/openai" },
    });
    expect(openai.def.type.kind).toBe("function");
  });

  it("describes a factory's parameters, with model IDs as suggestions", async () => {
    const { providers } = await resolveProject([PROVIDERS]);
    const openai = (providers as ValueFactory[]).find(
      f => f.def.name === "openai",
    )!;
    if (openai.def.type.kind !== "function") throw new Error("not a function");
    const [modelId] = openai.def.type.parameters;
    const suggestions = getOpenStringUnionInfo(modelId.type)?.suggestions;
    expect(suggestions?.length).toBeGreaterThan(5);
    expect(suggestions?.some(s => s.startsWith("gpt-"))).toBe(true);
  });

  it("filters out a provider whose call doesn't produce a language model", async () => {
    const { providers } = await resolveProject([PROVIDERS]);
    const names = (providers as ValueFactory[]).map(f => f.def.name);
    expect(names).not.toContain("elevenlabs");
  });

  it("filters out provider constructors", async () => {
    const { providers } = await resolveProject([PROVIDERS]);
    const names = (providers as ValueFactory[]).map(f => f.def.name);
    expect(names).not.toContain("createOpenAI");
    expect(names).not.toContain("createAnthropic");
  });

  it("lets an uninstalled module contribute nothing without spoiling its neighbours", async () => {
    const { providers } = await resolveProject([
      { ...PROVIDERS, modules: ["@ai-sdk/not-installed", "@ai-sdk/openai"] },
    ]);
    expect((providers as ValueFactory[]).map(f => f.def.name)).toEqual([
      "openai",
    ]);
  });
});

describe("project type probes", () => {
  it("resolves a type from an installed package, and `never` to null", async () => {
    const results = await resolveProject([
      { kind: "type", name: "model", expression: 'import("ai").LanguageModel' },
      { kind: "type", name: "nothing", expression: "never" },
      { kind: "type", name: "config", expression: "$config" },
    ]);
    expect((results.model as PropDefinition).name).toBe("model");
    expect(results.nothing).toBeNull();
    // A project probe has no prompt to name.
    expect(results.config).toBeNull();
  });

  it("caches results while the packages they read are unchanged", async () => {
    const ft = new TSPromptFileType(new LocalFileProvider());
    const request = { project: { rootDir: fixturesDir, probes: [PROVIDERS] } };
    const spy = vi.spyOn(promptProgram, "createPromptProgram");

    const first = await ft.resolveTypes(request);
    const builds = spy.mock.calls.length;
    const second = await ft.resolveTypes(request);

    expect(builds).toBe(1);
    expect(spy.mock.calls.length).toBe(1);
    expect(second.project).toEqual(first.project);
  });

  it("retries when the program built without the project's virtual module", async () => {
    const ft = new TSPromptFileType(new LocalFileProvider());
    // A prompt probe rides along, so the program builds and resolves something.
    // That alone used to count as "the project probes were answered".
    const request = {
      probes: [
        {
          probe: {
            kind: "type",
            name: "model",
            expression: 'import("ai").LanguageModel',
          } as TypeProbe,
          filePath: path.join(fixturesDir, "basic.prompt.ts"),
          promptName: "checkWeather",
        },
      ],
      project: { rootDir: fixturesDir, probes: [PROVIDERS] },
    };

    // A program that built — so the prompt probe resolves — but that doesn't
    // contain the virtual module the project probes live in. Nothing was
    // learned about them, so nothing about them is worth caching.
    const real = promptProgram.createPromptProgram;
    const spy = vi
      .spyOn(promptProgram, "createPromptProgram")
      .mockImplementationOnce((sources, previous) => {
        const program = real(sources, previous);
        if (!program) return program;
        return {
          ...program,
          getSourceFile: (filePath: string) =>
            filePath.includes("__evalution_project_probes__")
              ? undefined
              : program.getSourceFile(filePath),
        };
      });

    const first = await ft.resolveTypes(request);
    expect(first.probes[0]).toBeTruthy();
    expect(first.project?.providers).toBeUndefined();

    spy.mockRestore();
    const second = await ft.resolveTypes(request);
    expect(second.project?.providers).toBeDefined();
  });
});

/** Records the project results each prompt was normalized with. */
class ProbingSDK extends VercelAISDK {
  seen: (ProbeResults | undefined)[] = [];

  getProjectProbes(language: string): TypeProbe[] {
    return language === "typescript" ? [PROVIDERS] : [];
  }

  getPromptProbes(): TypeProbe[] {
    return [];
  }

  normalizePrompt(
    prompt: ParsedPrompt,
    promptProbes?: readonly ProbeResult[],
    project?: ProbeResults,
  ) {
    this.seen.push(project);
    return super.normalizePrompt(prompt, promptProbes);
  }
}

describe("project probes in a provider", () => {
  it("resolves once for several prompts, and not again on the next pass", async () => {
    const sdk = new ProbingSDK();
    const provider = new FilePromptProvider({
      rootDir: fixturesDir,
      includePatterns: [
        "basic.prompt.ts",
        "parameterized.prompt.ts",
        "multiple-exports.prompt.ts",
      ],
      playgroundIncludePatterns: [],
      sdk,
    });
    const spy = vi.spyOn(promptProgram, "createPromptProgram");

    const prompts = await provider.getAllPrompts();
    expect(prompts.length).toBeGreaterThan(2);
    // One build to parse, one for the project probes — however many prompts.
    expect(spy.mock.calls.length).toBe(2);
    expect(sdk.seen).toHaveLength(prompts.length);
    const [project] = sdk.seen;
    expect(
      (project?.providers as ValueFactory[]).map(f => f.def.name),
    ).toContain("openai");
    for (const seen of sdk.seen) expect(seen).toBe(project);

    await provider.getAllPrompts();
    // The second pass only parses: the project probes come from the cache.
    expect(spy.mock.calls.length).toBe(3);
  });

  it("reports every project probe, unresolved, when the file type can't evaluate types", async () => {
    const sdk = new ProbingSDK();
    const provider = new FilePromptProvider({
      rootDir: fixturesDir,
      includePatterns: ["basic.prompt.ts"],
      playgroundIncludePatterns: [],
      fileType: Object.assign(new TSPromptFileType(new LocalFileProvider()), {
        resolveTypes: undefined,
        resolveTypeProbes: undefined,
        resolveSlotMatches: undefined,
      }),
      sdk,
    });
    await provider.getAllPrompts();
    expect(sdk.seen[0]).toEqual({ providers: undefined });
  });
});

describe("unresolvable probes", () => {
  it("reports a type from a package that isn't installed as unevaluated", async () => {
    const results = await resolveProject([
      { kind: "type", name: "missing", expression: 'import("no-such-pkg").T' },
    ]);
    expect(results.missing).toBeUndefined();
  });

  it("reports factories as unevaluated when what they produce can't be resolved", async () => {
    const results = await resolveProject([
      { ...PROVIDERS, produces: 'import("no-such-pkg").Model' },
    ]);
    expect(results.providers).toBeUndefined();
  });
});
