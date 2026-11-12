// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { CloudProject } from "@evalution/sdk";
import { describe, expect, it, vi } from "vitest";
import { MemoryFileProvider } from "../file-provider-memory.ts";
import {
  chooseProject,
  configLinkedProject,
  link,
  linkConfigSource,
} from "./link.ts";

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
    expect(configLinkedProject(edit.kind === "linked" ? edit.source : "")).toBe(
      ID,
    );
  });

  it("reports a config that already names the project", () => {
    expect(
      linkConfigSource(`export default { cloud: { project: "prj_abc" } };`, ID),
    ).toEqual({ kind: "already", project: ID });
  });

  it("switches the project a config names, keeping its quotes", () => {
    expect(
      linkConfigSource(
        `export default {\n  cloud: { project: 'prj_old' },\n  useDotenv: true,\n};\n`,
        ID,
      ),
    ).toEqual({
      kind: "linked",
      previous: "prj_old",
      source: `export default {\n  cloud: { project: 'prj_abc' },\n  useDotenv: true,\n};\n`,
    });
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

  it("marks the linked project and keeps it by default", async () => {
    const client = fakeClient([project(1), project(2)]);
    const log = vi.fn();
    const ask = answers("");
    await expect(
      chooseProject(client, "dir", ask, { log }, "prj_2"),
    ).resolves.toEqual(project(2));
    expect(log).toHaveBeenCalledWith("  2. P2 (octo/p2) — linked now");
    expect(ask).toHaveBeenCalledWith("Link which? [2] ");
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

  it("notes the linked project and switches to another", async () => {
    const fileProvider = files(
      `export default { cloud: { project: "prj_1" } };`,
    );
    const log = vi.fn();
    const code = await link(ROOT, true, {
      client: fakeClient([project(1), project(2)]),
      ask: answers("2"),
      log: { log, error: () => {} },
      fileProvider,
    });
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("linked to prj_1");
    expect(await fileProvider.readFile(CONFIG)).toBe(
      `export default { cloud: { project: "prj_2" } };`,
    );
    expect(log.mock.calls.at(-1)?.[0]).toContain("Switched from prj_1 to P2");
  });

  it("leaves the config alone when the linked project is kept", async () => {
    const config = `export default { cloud: { project: "prj_1" } };`;
    const fileProvider = files(config);
    const log = vi.fn();
    await link(ROOT, true, {
      client: fakeClient([project(1)]),
      ask: answers(""),
      log: { log, error: () => {} },
      fileProvider,
    });
    expect(await fileProvider.readFile(CONFIG)).toBe(config);
    expect(log.mock.calls.at(-1)?.[0]).toContain("Still linked to P1");
  });

  it("prints the value to set when a linked config can't be edited", async () => {
    const config = `const p = "prj_1";\nexport default { cloud: { project: p } };`;
    const fileProvider = files(config);
    const log = vi.fn();
    await link(ROOT, true, {
      client: fakeClient([project(1), project(2)]),
      ask: answers("2"),
      log: { log, error: () => {} },
      fileProvider,
    });
    expect(await fileProvider.readFile(CONFIG)).toBe(config);
    expect(log.mock.calls.at(-1)?.[0]).toContain(
      `cloud: { project: "prj_2" },`,
    );
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
