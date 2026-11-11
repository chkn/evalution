// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { CloudProject } from "@evalution/sdk";
import { describe, expect, it, vi } from "vitest";
import { MemoryFileProvider } from "../file-provider-memory.ts";
import { chooseProject, link, linkConfigSource } from "./link.ts";

const ID = "prj_abc";

describe("linkConfigSource", () => {
  it("adds the field first in a multi-line default export", () => {
    const source = `import type { EvalutionConfig } from 'evalution';

export default {
  // Prompts
  promptProviders: [],
} satisfies EvalutionConfig;
`;
    expect(linkConfigSource(source, ID)).toEqual({
      kind: "linked",
      source: `import type { EvalutionConfig } from 'evalution';

export default {
  cloud: { project: 'prj_abc' },
  // Prompts
  promptProviders: [],
} satisfies EvalutionConfig;
`,
    });
  });

  it("quotes as the file does", () => {
    const edit = linkConfigSource(
      `import x from "evalution";\nexport default {\n\tuseDotenv: true,\n};\n`,
      ID,
    );
    expect(edit).toMatchObject({ kind: "linked" });
    expect(edit.kind === "linked" && edit.source).toContain(
      `{\n\tcloud: { project: "prj_abc" },\n\tuseDotenv: true,`,
    );
  });

  it.each([
    ["a one-line object", "export default { useDotenv: true };"],
    ["an empty object", "export default {};"],
    ["`as`", "export default { useDotenv: true } as EvalutionConfig;"],
    ["parentheses", "export default ({ useDotenv: true });"],
    ["a call", "export default defineConfig({ useDotenv: true });"],
    ["a spread", "export default { ...base };"],
    [
      "a variable",
      "const config = { useDotenv: true } satisfies C;\nexport default config;",
    ],
  ])("edits %s", (_name, source) => {
    const edit = linkConfigSource(source, ID);
    expect(edit.kind).toBe("linked");
    expect(
      linkConfigSource(edit.kind === "linked" ? edit.source : "", "prj_other"),
    ).toEqual({ kind: "already", project: ID });
  });

  it("reports the project a config already names", () => {
    expect(
      linkConfigSource(`export default { cloud: { project: "prj_old" } };`, ID),
    ).toEqual({ kind: "already", project: "prj_old" });
  });

  it.each([
    ["no default export", "export const config = {};"],
    ["an imported config", 'import c from "./c";\nexport default c;'],
    ["a computed cloud", "export default { cloud: makeCloud() };"],
    ["a shorthand cloud", "const cloud = {};\nexport default { cloud };"],
  ])("leaves %s to the user", (_name, source) => {
    expect(linkConfigSource(source, ID)).toEqual({
      kind: "manual",
      line: `cloud: { project: "${ID}" },`,
    });
  });
});

const project = (n: number): CloudProject => ({
  id: `prj_${n}`,
  slug: `p${n}`,
  name: `P${n}`,
  orgSlug: "octo",
});

function fakeClient(projects: CloudProject[]) {
  return {
    listProjects: vi.fn(async () => projects),
    createProject: vi.fn(async ({ name }: { name: string }) => ({
      ...project(99),
      name,
    })),
  };
}

const answers = (...replies: string[]) => {
  const queue = [...replies];
  return vi.fn(async () => queue.shift() ?? "");
};

const quiet = { log: () => {}, error: () => {} };

describe("chooseProject", () => {
  it("picks an existing project by number", async () => {
    const client = fakeClient([project(1), project(2)]);
    await expect(
      chooseProject(client, "dir", answers("2"), quiet),
    ).resolves.toEqual(project(2));
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it("asks again after a wrong answer", async () => {
    const client = fakeClient([project(1)]);
    await expect(
      chooseProject(client, "dir", answers("7", "x", "1"), quiet),
    ).resolves.toEqual(project(1));
  });

  it("creates a project named after the directory by default", async () => {
    const client = fakeClient([project(1)]);
    const chosen = await chooseProject(
      client,
      "my-app",
      answers("", ""),
      quiet,
    );
    expect(client.createProject).toHaveBeenCalledWith({ name: "my-app" });
    expect(chosen.name).toBe("my-app");
  });

  it("asks only for a name when there are no projects", async () => {
    const client = fakeClient([]);
    const ask = answers("Shop");
    await chooseProject(client, "dir", ask, quiet);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(client.createProject).toHaveBeenCalledWith({ name: "Shop" });
  });
});

describe("link", () => {
  const ROOT = "/work/app";
  const CONFIG = path.join(ROOT, ".evalution", "config.ts");
  const files = (config?: string) =>
    new MemoryFileProvider(config === undefined ? {} : { [CONFIG]: config });

  it("needs a personal key", async () => {
    const error = vi.fn();
    await expect(
      link("/nowhere", false, {
        env: { EVALUTION_API_KEY: "evl_ingest_x" },
        log: { log: () => {}, error },
      }),
    ).resolves.toBe(1);
    expect(error.mock.calls[0][0]).toContain("personal API key");
  });

  it("writes the chosen project into the config", async () => {
    const fileProvider = files("export default {\n  useDotenv: true,\n};\n");
    const code = await link(ROOT, true, {
      client: fakeClient([project(1)]),
      ask: answers("1"),
      log: quiet,
      fileProvider,
    });
    expect(code).toBe(0);
    expect(await fileProvider.readFile(CONFIG)).toContain(
      `cloud: { project: "prj_1" },`,
    );
  });

  it("asks nothing when the config is already linked", async () => {
    const config = `export default { cloud: { project: "prj_old" } };`;
    const fileProvider = files(config);
    const client = fakeClient([]);
    const log = vi.fn();
    await link(ROOT, true, {
      client,
      log: { log, error: () => {} },
      fileProvider,
    });
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("prj_old");
    expect(await fileProvider.readFile(CONFIG)).toBe(config);
  });

  it("prints the line when there's no config to add it to", async () => {
    const fileProvider = files();
    const log = vi.fn();
    await link(ROOT, false, {
      client: fakeClient([project(1)]),
      ask: answers("1"),
      log: { log, error: () => {} },
      fileProvider,
    });
    expect(log.mock.calls.at(-1)?.[0]).toContain(
      `cloud: { project: "prj_1" },`,
    );
    await expect(fileProvider.readFile(CONFIG)).rejects.toThrow();
  });

  it("reports a cloud refusal", async () => {
    const error = vi.fn();
    const client = fakeClient([]);
    client.createProject.mockRejectedValue(new Error("Evalution API: 409"));
    await expect(
      link(ROOT, true, {
        client,
        ask: answers("x"),
        log: { log: () => {}, error },
        fileProvider: files("export default {};"),
      }),
    ).resolves.toBe(1);
    expect(error.mock.calls[0][0]).toContain("409");
  });
});
