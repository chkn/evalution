// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * `evalution link`: links the project to an Evalution Cloud project by
 * writing its id into `.evalution/config.ts`, where everyone who clones the
 * repo gets it.
 */

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { apiKeyKind, type CloudProject, Evalution } from "@evalution/sdk";
import ts from "typescript";
import type { FileProvider } from "../file-provider.ts";
import { LocalFileProvider } from "../file-provider-local.ts";

/** What {@link linkConfigSource} makes of a config file. */
export type ConfigEdit =
  /** The field was added; `source` is the new file. */
  | { kind: "linked"; source: string }
  /** The config already names a project. */
  | { kind: "already"; project: string }
  /** It couldn't be edited safely: `line` is what to add by hand. */
  | { kind: "manual"; line: string };

/** Strips what wraps a config object: `satisfies`, `as`, parentheses, `defineConfig(…)`. */
function unwrap(node: ts.Expression): ts.Expression {
  while (true) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      node = node.expression;
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      node = node.arguments[0];
    } else {
      return node;
    }
  }
}

/** The object the file's default export is, if it's one written out in the file. */
function defaultExportObject(
  file: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
  const exported = file.statements.find(
    (s): s is ts.ExportAssignment =>
      ts.isExportAssignment(s) && !s.isExportEquals,
  );
  if (!exported) return undefined;
  let node = unwrap(exported.expression);
  // `const config = { … }; export default config;`
  if (ts.isIdentifier(node)) {
    const name = node.text;
    const declaration = file.statements
      .filter(ts.isVariableStatement)
      .flatMap(s => s.declarationList.declarations)
      .find(d => ts.isIdentifier(d.name) && d.name.text === name);
    if (!declaration?.initializer) return undefined;
    node = unwrap(declaration.initializer);
  }
  return ts.isObjectLiteralExpression(node) ? node : undefined;
}

const propertyNamed = (object: ts.ObjectLiteralExpression, name: string) =>
  object.properties.find(
    p =>
      p.name &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name,
  );

/** The project a config's `cloud.project` names, or `null` for a `cloud` it can't read. */
function linkedProject(
  object: ts.ObjectLiteralExpression,
): string | null | undefined {
  const cloud = propertyNamed(object, "cloud");
  if (!cloud) return undefined;
  if (!ts.isPropertyAssignment(cloud)) return null;
  const value = unwrap(cloud.initializer);
  if (!ts.isObjectLiteralExpression(value)) return null;
  const project = propertyNamed(value, "project");
  return project &&
    ts.isPropertyAssignment(project) &&
    ts.isStringLiteralLike(project.initializer)
    ? project.initializer.text
    : null;
}

/**
 * Adds `cloud: { project }` to a config file's source, as the first field of
 * its default export. Anything it can't be sure of is left for the user.
 */
export function linkConfigSource(source: string, project: string): ConfigEdit {
  // Quote as the file does.
  const quote = /from\s+'/.test(source) ? "'" : '"';
  const field = `cloud: { project: ${quote}${project}${quote} },`;
  const manual = { kind: "manual", line: field } as const;

  const parse = (text: string) =>
    ts.createSourceFile("config.ts", text, ts.ScriptTarget.Latest, true);
  const file = parse(source);
  const object = defaultExportObject(file);
  if (!object) return manual;
  const existing = linkedProject(object);
  if (typeof existing === "string")
    return { kind: "already", project: existing };
  if (existing === null) return manual;

  const open = object.getStart(file);
  let edited: string;
  const [first] = object.properties;
  if (!first) {
    if (object.getText(file).replace(/\s/g, "") !== "{}") return manual;
    edited = `${source.slice(0, open)}{\n  ${field}\n}${source.slice(object.end)}`;
  } else {
    const firstStart = first.getStart(file);
    const line = (pos: number) => file.getLineAndCharacterOfPosition(pos).line;
    if (line(firstStart) > line(open)) {
      const lineStart = file.getPositionOfLineAndCharacter(line(firstStart), 0);
      const indent = source.slice(lineStart, firstStart);
      if (/\S/.test(indent)) return manual;
      edited = `${source.slice(0, open + 1)}\n${indent}${field}${source.slice(open + 1)}`;
    } else {
      edited = `${source.slice(0, open + 1)} ${field}${source.slice(open + 1)}`;
    }
  }

  // Only keep an edit that reads back as intended.
  const check = defaultExportObject(parse(edited));
  return check && linkedProject(check) === project
    ? { kind: "linked", source: edited }
    : manual;
}

/** Asks the user a question and resolves to their answer. */
export type Ask = (question: string) => Promise<string>;

/**
 * The project to link: one of `projects`, picked by number, or a new one,
 * named after the directory unless the user gives a name.
 */
export async function chooseProject(
  client: Pick<Evalution, "listProjects" | "createProject">,
  defaultName: string,
  ask: Ask,
  log: Pick<Console, "log"> = console,
): Promise<CloudProject> {
  const projects = await client.listProjects();
  if (projects.length > 0) {
    log.log("Your Evalution Cloud projects:");
    projects.forEach((p, i) => {
      log.log(`  ${i + 1}. ${p.name} (${p.orgSlug}/${p.slug})`);
    });
    log.log(`  ${projects.length + 1}. A new project`);
    while (true) {
      const answer = (
        await ask(`Link which? [${projects.length + 1}] `)
      ).trim();
      const n = answer === "" ? projects.length + 1 : Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= projects.length) {
        return projects[n - 1];
      }
      if (n === projects.length + 1) break;
    }
  }
  const name =
    (await ask(`Name the new project: [${defaultName}] `)).trim() ||
    defaultName;
  return client.createProject({ name });
}

/** Runs `evalution link` for the project at `rootDir`. Resolves to the exit code. */
export async function link(
  rootDir: string,
  hasConfig: boolean,
  {
    env = process.env,
    ask,
    client,
    log = console,
    fileProvider = new LocalFileProvider(),
  }: {
    env?: NodeJS.ProcessEnv;
    ask?: Ask;
    client?: Pick<Evalution, "listProjects" | "createProject">;
    log?: Pick<Console, "log" | "error">;
    fileProvider?: FileProvider;
  } = {},
): Promise<number> {
  const apiKey = env.EVALUTION_API_KEY;
  if (!client && (!apiKey || apiKeyKind(apiKey) !== "personal")) {
    log.error(
      "`evalution link` needs a personal API key. Create one at https://evalut.io/cloud and set it as EVALUTION_API_KEY, in your shell or the project's .env.",
    );
    return 1;
  }

  const configPath = path.join(rootDir, ".evalution", "config.ts");
  const source = hasConfig
    ? await fileProvider.readFile(configPath)
    : undefined;
  if (source !== undefined) {
    // Say so before asking anything.
    const edit = linkConfigSource(source, "prj_");
    if (edit.kind === "already") {
      log.log(
        `This project is already linked to ${edit.project}. To link another, change \`cloud.project\` in ${configPath}.`,
      );
      return 0;
    }
  }

  let readline: ReturnType<typeof createInterface> | undefined;
  const askUser: Ask =
    ask ??
    (question => {
      readline ??= createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return readline.question(question);
    });
  let project: CloudProject;
  try {
    project = await chooseProject(
      client ?? new Evalution({ apiKey, endpoint: false }),
      path.basename(rootDir),
      askUser,
      log,
    );
  } catch (err) {
    log.error(`Couldn't link the project: ${(err as Error).message}`);
    return 1;
  } finally {
    readline?.close();
  }

  if (source === undefined) {
    log.log(
      `Picked ${project.name}. This directory has no .evalution/config.ts yet: run \`npx evalution\` to set it up, then add this to its default export:\n\n  cloud: { project: "${project.id}" },\n`,
    );
    return 0;
  }
  const edit = linkConfigSource(source, project.id);
  if (edit.kind === "linked") {
    await fileProvider.writeFile(configPath, edit.source);
    log.log(
      `✅ Linked to ${project.name}. Commit ${path.relative(process.cwd(), configPath) || configPath} so everyone who clones the repo is linked too.`,
    );
  } else {
    log.log(
      `Couldn't edit ${configPath} safely. Add this to its default export:\n\n  ${edit.kind === "manual" ? edit.line : `cloud: { project: "${project.id}" },`}\n`,
    );
  }
  return 0;
}
