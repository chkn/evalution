// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import type { PropDefinition, PropValue } from "ts-proppy";
import {
  addProperty as applyAdd,
  removeProperty as applyRemove,
  updateProperty as applyUpdate,
  buildPropTypeFromType,
  extractPropertiesFromObjectLiteral,
  extractPropertiesFromParameters,
} from "ts-proppy";
import ts from "typescript";
import type { FileProvider } from "../../../file-provider.ts";
import { LocalFileProvider } from "../../../file-provider-local.ts";
import type { CalleeBinding, ModelPropValue } from "../../../shared/types.ts";
import type {
  ParsedFilePrompt,
  ParsePromptsOptions,
  PromptFileType,
  SlotMatchRequest,
  TypeProbe,
  TypeProbeRequest,
  TypeResolutionRequest,
  TypeResolutionResult,
} from "../prompt-file-type.ts";
import type { PromptProgram } from "./prompt-program.ts";
import { createPromptProgram } from "./prompt-program.ts";
import { collectSlotTypes, matchByAssignability } from "./slot-matching.ts";

/**
 * {@link PromptFileType} implementation for TypeScript `.prompt.ts` files.
 *
 * Each prompt is an exported function that returns an SDK-specific config
 * object. For example, for the Vercel AI SDK, a prompt file might look like this:
 *
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 *
 * export function myPrompt() {
 *   return {
 *     model: openai('gpt-4o'),
 *     system: 'You are a helpful assistant.',
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *   };
 * }
 * ```
 *
 * @example
 * ```ts
 * const fileType = new TSPromptFileType();
 * const prompts = await fileType.parsePrompts(['/path/to/my.prompt.ts'], '/path/to');
 * ```
 */

function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

export class TSPromptFileType implements PromptFileType {
  readonly language = "typescript";
  defaultIncludePatterns = ["**/*.prompt.ts", "**/*.promp.ts"];
  defaultFileExtension = ".prompt.ts";

  newPromptSkeleton(
    promptsId: string,
    name: string,
    importPath: string,
  ): string {
    const key = isValidIdentifier(name) ? name : `[${JSON.stringify(name)}]`;
    return `import { prompts } from ${JSON.stringify(importPath)};

export default prompts(
  { id: ${JSON.stringify(promptsId)} },
  () => ({
    ${key}: () => ({
    })
}));`;
  }

  private fileProvider: FileProvider;

  /** Kept between parses so TypeScript can reuse unchanged source files. */
  private previousProgram?: ts.Program;

  constructor(fileProvider: FileProvider = new LocalFileProvider()) {
    this.fileProvider = fileProvider;
  }

  async parsePrompts(
    files: string[],
    rootDir: string = "",
    { companionFiles = [] }: ParsePromptsOptions = {},
  ): Promise<ParsedFilePrompt[]> {
    const sources = await this.readAll(files);

    // Playground modules join the same program as the prompts they serve, so
    // the checker can name both sides of a resource-to-slot match. They are
    // roots, not overlays, because nothing in the prompt files imports them.
    const companions = await this.readAll(
      companionFiles.filter(f => !sources.has(f)),
    );
    const program = this.buildProgram(new Map([...sources, ...companions]));

    return [...sources].flatMap(([filePath, sourceCode]) =>
      this.parseFileContent(
        filePath,
        sourceCode,
        rootDir,
        program?.getSourceFile(filePath),
        program?.typeChecker,
      ),
    );
  }

  /**
   * Evaluates probes and slot matches by injecting each expression into the
   * file it concerns as a type alias and asking the checker what it resolves
   * to.
   *
   * Everything rides in **one** program build. A build brings a fresh checker
   * that re-derives every type the files depend on — for a config that infers
   * tool types, hundreds of milliseconds — while an extra alias in an existing
   * build is nearly free.
   */
  async resolveTypes({
    probes = [],
    slotMatches = [],
  }: TypeResolutionRequest): Promise<TypeResolutionResult> {
    const result: TypeResolutionResult = {
      probes: probes.map(() => undefined),
      slotMatches: slotMatches.map(() => ({})),
    };
    if (probes.length === 0 && slotMatches.length === 0) return result;

    await this.withInjectedTypes(
      [
        ...probes.map(req => ({
          filePath: req.filePath,
          promptName: req.promptName,
          expressions: { probe: req.probe.expression },
        })),
        ...slotMatches.map(req => ({
          filePath: req.filePath,
          promptName: req.promptName,
          expressions: slotMatchExpressions(req),
        })),
      ],
      (index, resolve, program, sourceFile) => {
        if (index < probes.length) {
          result.probes[index] = evaluateProbe(
            probes[index].probe,
            resolve,
            program,
            sourceFile,
          );
        } else {
          const i = index - probes.length;
          result.slotMatches[i] = matchSlots(
            slotMatches[i],
            resolve,
            program,
            sourceFile,
          );
        }
      },
    );

    return result;
  }

  async resolveTypeProbes(
    requests: readonly TypeProbeRequest[],
  ): Promise<(PropDefinition | null | undefined)[]> {
    return (await this.resolveTypes({ probes: requests })).probes;
  }

  async resolveSlotMatches(
    requests: readonly SlotMatchRequest[],
  ): Promise<Record<string, string[]>[]> {
    return (await this.resolveTypes({ slotMatches: requests })).slotMatches;
  }

  /**
   * Evaluate named type expressions in the scope of the prompt files they
   * concern, in a single program build.
   *
   * Each expression becomes a `type` alias appended to its own prompt file, so
   * it is evaluated where the file's own imports and declarations are visible,
   * and `$config` is substituted for a way to name what that prompt returns.
   * `visit` is then called once per request with a `resolve(name)` that hands
   * back the type each alias landed on.
   *
   * Batching is the whole point: one build serves every request, however many
   * aliases they contribute between them.
   */
  private async withInjectedTypes(
    requests: readonly {
      filePath: string;
      promptName: string;
      expressions: Record<string, string>;
    }[],
    visit: (
      index: number,
      resolve: (name: string) => ts.Type | undefined,
      program: PromptProgram,
      sourceFile: ts.SourceFile,
    ) => void,
  ): Promise<void> {
    // Alias names are scoped by request index so two prompts in one file can
    // contribute expressions with the same local name without colliding.
    const alias = (index: number, name: string) =>
      `__evalution_t${index}_${name}`;

    const byFile = new Map<string, number[]>();
    requests.forEach((req, index) => {
      const list = byFile.get(req.filePath);
      if (list) list.push(index);
      else byFile.set(req.filePath, [index]);
    });

    const sources = new Map<string, string>();
    for (const [filePath, indices] of byFile) {
      let sourceCode: string;
      try {
        sourceCode = await this.fileProvider.readFile(filePath);
      } catch {
        continue;
      }
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceCode,
        ts.ScriptTarget.ESNext,
        true,
      );

      const lines: string[] = [];
      for (const index of indices) {
        const request = requests[index];
        const config = this.configTypeExpression(
          sourceFile,
          filePath,
          request.promptName,
        );
        for (const [name, expression] of Object.entries(request.expressions)) {
          const substituted = config
            ? expression.replaceAll("$config", config)
            : expression;
          // An expression that still wants `$config` in a file whose shape we
          // could not read would not compile; `never` is the honest stand-in
          // and reads downstream as "no such requirement".
          const rhs =
            !config && expression.includes("$config") ? "never" : substituted;
          lines.push(`type ${alias(index, name)} = ${rhs}`);
        }
      }
      if (lines.length > 0) {
        sources.set(filePath, `${sourceCode}\n${lines.join("\n")}\n`);
      }
    }

    const program = this.buildProgram(sources);
    if (!program) return;

    for (const [filePath, indices] of byFile) {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) continue;
      for (const index of indices) {
        visit(
          index,
          name =>
            resolveTypeAlias(
              sourceFile,
              alias(index, name),
              program.typeChecker,
            ),
          program,
          sourceFile,
        );
      }
    }
  }

  /**
   * A type expression naming what the prompt named `promptName` returns, to
   * substitute for a probe's `$config` token.
   *
   * Which shape a prompt file uses is this file type's knowledge: an exported
   * function declaration can be named directly, while a prompt defined through
   * the `prompts()` helper lives inside an anonymous default export and has to
   * be reached by importing the module back into itself.
   */
  private configTypeExpression(
    sourceFile: ts.SourceFile,
    filePath: string,
    promptName: string,
  ): string | undefined {
    let shape: "function" | "helper" | undefined;
    const visit = (node: ts.Node) => {
      if (shape) return;
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === promptName &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        shape = "function";
        return;
      }
      if (ts.isExportAssignment(node)) {
        const helper = findPromptsHelperCall(node.expression);
        if (
          helper?.object.properties.some(p => getPropertyName(p) === promptName)
        ) {
          shape = "helper";
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (shape === "function") return `ReturnType<typeof ${promptName}>`;
    if (shape === "helper") {
      // TypeScript substitutes `.js` for `.ts` on a relative specifier under
      // every resolution mode, so this names the file itself without depending
      // on `allowImportingTsExtensions`.
      const self = `./${path.basename(filePath).replace(/\.ts$/, ".js")}`;
      return (
        `ReturnType<ReturnType<typeof import(${JSON.stringify(self)}).default>` +
        `[${JSON.stringify(promptName)}]>`
      );
    }
    return undefined;
  }

  private async readAll(
    files: readonly string[],
  ): Promise<Map<string, string>> {
    return new Map(
      await Promise.all(
        files.map(
          async filePath =>
            [filePath, await this.fileProvider.readFile(filePath)] as const,
        ),
      ),
    );
  }

  /**
   * Build a program over `sources`, reusing the previous one's unchanged
   * source files.
   *
   * Type resolution is best-effort: a project whose tsconfig or imports fail
   * to load still parses, just without checker-backed types.
   */
  private buildProgram(
    sources: ReadonlyMap<string, string>,
  ): PromptProgram | undefined {
    try {
      const program = createPromptProgram(sources, this.previousProgram);
      this.previousProgram = program?.program;
      return program;
    } catch {
      return undefined;
    }
  }

  async updateProperty(
    filePath: string,
    propDef: PropDefinition,
    value: ModelPropValue,
    promptId?: string,
  ): Promise<void> {
    if (!propDef.valueSpan) {
      throw new Error(`Property '${propDef.name}' is missing valueSpan`);
    }

    let sourceCode = await this.fileProvider.readFile(filePath);

    // Resolve binding-array candidates and augment any matching destructure.
    const adjusted = resolveBindingsAndAugment(sourceCode, value);
    sourceCode = adjusted.sourceCode;
    const resolvedValue = adjusted.value;

    // Re-parse to get fresh spans (guards against stale spans from concurrent saves
    // and against shifts introduced by destructure-augmentation above).
    const functionName = promptId?.slice(promptId.lastIndexOf("#") + 1);
    if (functionName) {
      const freshDef = this.findFreshDefinition(
        sourceCode,
        filePath,
        functionName,
        propDef.name,
      );
      if (freshDef) {
        propDef = {
          ...propDef,
          valueSpan: freshDef.valueSpan,
          fullSpan: freshDef.fullSpan,
        };
      }
    }

    sourceCode = applyUpdate(sourceCode, propDef, resolvedValue);
    await this.fileProvider.writeFile(filePath, sourceCode);
  }

  async removeProperty(
    filePath: string,
    propDef: PropDefinition,
  ): Promise<void> {
    if (!propDef.fullSpan) {
      throw new Error(`Property '${propDef.name}' is missing fullSpan`);
    }
    const sourceCode = await this.fileProvider.readFile(filePath);
    const newSourceCode = applyRemove(sourceCode, propDef);
    await this.fileProvider.writeFile(filePath, newSourceCode);
  }

  async addProperty(
    filePath: string,
    promptName: string,
    propertyName: string,
    value: ModelPropValue,
  ): Promise<void> {
    let sourceCode = await this.fileProvider.readFile(filePath);

    const adjusted = resolveBindingsAndAugment(sourceCode, value);
    sourceCode = adjusted.sourceCode;
    const resolvedValue = adjusted.value;

    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
    );
    const returnObj = this.findReturnObjectInSource(sourceFile, promptName);
    if (!returnObj)
      throw new Error(`Return object not found in function '${promptName}'`);

    const extracted = extractPropertiesFromObjectLiteral(
      returnObj,
      undefined,
      sourceFile,
    );
    sourceCode = applyAdd(sourceCode, extracted, propertyName, resolvedValue);
    await this.fileProvider.writeFile(filePath, sourceCode);
  }

  async renamePrompt(
    filePath: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const sourceCode = await this.fileProvider.readFile(filePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
    );

    let nameStart = -1;
    let nameEnd = -1;
    let isFunctionDeclaration = false;

    const visit = (node: ts.Node) => {
      if (nameStart >= 0) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === oldName) {
        nameStart = node.name.getStart(sourceFile);
        nameEnd = node.name.getEnd();
        isFunctionDeclaration = true;
        return;
      }
      if (ts.isExportAssignment(node)) {
        const helper = findPromptsHelperCall(node.expression);
        if (helper) {
          for (const prop of helper.object.properties) {
            if (getPropertyName(prop) === oldName) {
              const nameNode = (
                prop as ts.MethodDeclaration | ts.PropertyAssignment
              ).name;
              nameStart = nameNode.getStart(sourceFile);
              nameEnd = nameNode.getEnd();
              return;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (nameStart < 0)
      throw new Error(`Function '${oldName}' not found in ${filePath}`);

    if (!isValidIdentifier(newName) && isFunctionDeclaration) {
      throw new Error(`'${newName}' is not a valid function name`);
    }
    const replacement = isValidIdentifier(newName)
      ? newName
      : `[${JSON.stringify(newName)}]`;
    const newSource =
      sourceCode.slice(0, nameStart) + replacement + sourceCode.slice(nameEnd);
    await this.fileProvider.writeFile(filePath, newSource);
  }

  async loadConfig(
    filePath: string,
    promptName: string,
    params: any[],
  ): Promise<any> {
    const module = await this.fileProvider.import(filePath);
    let fn = module[promptName];

    // Fall back to the prompts() helper shape: `export default prompts(factory)`
    // resolves to a function that returns an object of prompt methods.
    if (typeof fn !== "function" && typeof module.default === "function") {
      const obj = module.default();
      if (obj && typeof obj[promptName] === "function")
        fn = obj[promptName].bind(obj);
    }

    if (typeof fn !== "function") {
      throw new Error(`Function '${promptName}' not found in ${filePath}`);
    }

    const config = fn(...params);

    if (!config || typeof config !== "object") {
      throw new Error(`'${promptName}' did not return a valid config object`);
    }

    return config;
  }

  // #region Parsing

  private parseFileContent(
    filePath: string,
    sourceCode: string,
    rootDir: string,
    programSourceFile?: ts.SourceFile,
    typeChecker?: ts.TypeChecker,
  ): ParsedFilePrompt[] {
    // The checker can only resolve nodes belonging to its own program, so the
    // two must travel together: use the program's source file, or neither.
    const sourceFile =
      programSourceFile ??
      ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ESNext, true);
    const checker = programSourceFile ? typeChecker : undefined;
    const prompts: ParsedFilePrompt[] = [];

    const visitNode = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const isExported = node.modifiers?.some(
          mod => mod.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (isExported) {
          const prompt = this.parseFunctionDeclaration(
            node,
            sourceFile,
            filePath,
            rootDir,
            checker,
          );
          if (prompt) prompts.push(prompt);
        }
      } else if (ts.isExportAssignment(node)) {
        const helper = findPromptsHelperCall(node.expression);
        if (helper) {
          for (const prop of helper.object.properties) {
            const parsed = this.parseHelperProperty(
              prop,
              sourceFile,
              filePath,
              rootDir,
              helper.moduleId,
              checker,
            );
            if (parsed) prompts.push(parsed);
          }
        }
      }
      ts.forEachChild(node, visitNode);
    };

    visitNode(sourceFile);
    return prompts;
  }

  private parseHelperProperty(
    prop: ts.ObjectLiteralElementLike,
    sourceFile: ts.SourceFile,
    filePath: string,
    rootDir: string,
    moduleId?: string,
    typeChecker?: ts.TypeChecker,
  ): ParsedFilePrompt | null {
    const name = getPropertyName(prop);
    if (!name) return null;

    const fn = getPropertyFunction(prop);
    if (!fn) return null;

    const returnObject = findReturnObjectInFunctionLike(fn);
    if (!returnObject) return null;

    const functionParameters = extractPropertiesFromParameters(
      fn.parameters,
      sourceFile,
      typeChecker,
    ).definitions;
    const relativeFilePath = rootDir
      ? path.relative(rootDir, filePath)
      : filePath;
    const extractedProps = extractPropertiesFromObjectLiteral(
      returnObject,
      undefined,
      sourceFile,
    );
    const treePath = relativeFilePath.split("/").filter(Boolean);

    return {
      id: `${relativeFilePath}#${name}`,
      globalId: moduleId ? `${moduleId}#${name}` : undefined,
      name,
      functionParameters,
      extractedProps,
      metadata: { relativeFilePath },
      treePath,
    };
  }

  private parseFunctionDeclaration(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    rootDir: string,
    typeChecker?: ts.TypeChecker,
  ): ParsedFilePrompt | null {
    if (!node.name) return null;

    const functionName = node.name.text;
    const functionParameters = extractPropertiesFromParameters(
      node.parameters,
      sourceFile,
      typeChecker,
    ).definitions;
    const returnObject = this.findReturnObjectInFunction(node);
    if (!returnObject) return null;

    const relativeFilePath = rootDir
      ? path.relative(rootDir, filePath)
      : filePath;
    const promptId = `${relativeFilePath}#${functionName}`;
    const extractedProps = extractPropertiesFromObjectLiteral(
      returnObject,
      undefined,
      sourceFile,
    );
    const treePath = relativeFilePath.split("/").filter(Boolean);

    return {
      id: promptId,
      name: functionName,
      functionParameters,
      extractedProps,
      metadata: { relativeFilePath },
      treePath,
    };
  }

  // #endregion
  // #region Editing helpers

  private findFreshDefinition(
    sourceCode: string,
    filePath: string,
    functionName: string,
    propertyName: string,
  ): PropDefinition | null {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
    );
    const returnObj = this.findReturnObjectInSource(sourceFile, functionName);
    if (!returnObj) return null;

    const extracted = extractPropertiesFromObjectLiteral(
      returnObj,
      undefined,
      sourceFile,
    );
    return extracted.definitions.find(d => d.name === propertyName) ?? null;
  }

  private findReturnObjectInFunction(
    node: ts.FunctionDeclaration,
  ): ts.ObjectLiteralExpression | null {
    let returnObject: ts.ObjectLiteralExpression | null = null;

    const visitNode = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && n.expression) {
        if (ts.isObjectLiteralExpression(n.expression)) {
          returnObject = n.expression;
        }
      } else if (
        ts.isArrowFunction(n) &&
        ts.isObjectLiteralExpression(n.body)
      ) {
        returnObject = n.body;
      }
      if (!returnObject) ts.forEachChild(n, visitNode);
    };

    if (node.body) visitNode(node.body);
    return returnObject;
  }

  private findReturnObjectInSource(
    sourceFile: ts.SourceFile,
    functionName: string,
  ): ts.ObjectLiteralExpression | null {
    let returnObj: ts.ObjectLiteralExpression | null = null;

    const visitFunc = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
        returnObj = this.findReturnObjectInFunction(node);
        return;
      }
      if (ts.isExportAssignment(node)) {
        const helper = findPromptsHelperCall(node.expression);
        if (helper) {
          for (const prop of helper.object.properties) {
            if (getPropertyName(prop) === functionName) {
              const fn = getPropertyFunction(prop);
              if (fn) returnObj = findReturnObjectInFunctionLike(fn);
              return;
            }
          }
        }
      }
      if (!returnObj) ts.forEachChild(node, visitFunc);
    };
    visitFunc(sourceFile);

    return returnObj;
  }
  // #endregion
}

/** Make an arbitrary key safe to embed in a TypeScript identifier. */
function sourceAlias(key: string): string {
  return `src_${aliasSafe(key)}`;
}

function slotAlias(name: string): string {
  return `slot_${aliasSafe(name)}`;
}

/** The aliases a slot match needs injected: one per source, one per extra root. */
function slotMatchExpressions(
  request: SlotMatchRequest,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      request.sources.map(src => [sourceAlias(src.key), src.expression]),
    ),
    ...Object.fromEntries(
      Object.entries(request.extraSlots ?? {}).map(([name, expression]) => [
        slotAlias(name),
        expression,
      ]),
    ),
  };
}

/** What a probe's injected alias resolved to, reported three-valued. */
function evaluateProbe(
  probe: TypeProbe,
  resolve: (name: string) => ts.Type | undefined,
  program: PromptProgram,
  sourceFile: ts.SourceFile,
): PropDefinition | null | undefined {
  const type = resolve("probe");
  if (!type) return undefined;
  // `never` is a defensively-written probe saying "this prompt has no such
  // requirement". Reported as `null` rather than left `undefined`, which would
  // be indistinguishable from a failure to evaluate — and a caller must not
  // degrade a definite "no" into a placeholder.
  if (type.flags & ts.TypeFlags.Never) return null;
  const built = buildPropTypeFromType(type, program.typeChecker, sourceFile);
  const def: PropDefinition = {
    name: probe.name,
    type: probe.syntax ? { ...built, syntax: probe.syntax } : built,
    optional: false,
  };
  if (probe.description) def.description = probe.description;
  return def;
}

/** Which of a request's sources fit which of its slots, by assignability. */
function matchSlots(
  request: SlotMatchRequest,
  resolve: (name: string) => ts.Type | undefined,
  program: PromptProgram,
  sourceFile: ts.SourceFile,
): Record<string, string[]> {
  const { typeChecker } = program;

  // Root slots: the prompt function's own parameters, plus any extra roots the
  // caller named (execute parameters, whose types are nowhere in the
  // signature). An extra root that doesn't resolve, or resolves to `never`,
  // contributes no slots.
  const roots = new Map<string, ts.Type>();
  const fn = findPromptFunctionLike(sourceFile, request.promptName);
  for (const parameter of fn?.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) continue;
    roots.set(parameter.name.text, typeChecker.getTypeAtLocation(parameter));
  }
  for (const name of Object.keys(request.extraSlots ?? {})) {
    const type = resolve(slotAlias(name));
    if (type && !(type.flags & ts.TypeFlags.Never)) roots.set(name, type);
  }

  const sourceTypes = new Map<string, ts.Type>();
  for (const src of request.sources) {
    const type = resolve(sourceAlias(src.key));
    // A source whose type will not resolve matches nothing here; the caller
    // still has the name rule to fall back on.
    if (!type || type.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any)) {
      continue;
    }
    sourceTypes.set(src.key, type);
  }
  if (sourceTypes.size === 0) return {};

  return matchByAssignability(
    collectSlotTypes(roots, typeChecker, sourceFile),
    sourceTypes,
    typeChecker,
  );
}

function aliasSafe(key: string): string {
  return key.replace(/[^A-Za-z0-9_$]/g, "_");
}

/**
 * The function-like node a prompt is defined by, in either shape this file
 * type recognises — a top-level exported declaration, or a property of the
 * object a `prompts()` helper's factory returns.
 */
function findPromptFunctionLike(
  sourceFile: ts.SourceFile,
  promptName: string,
): ts.FunctionDeclaration | FunctionLike | undefined {
  let found: ts.FunctionDeclaration | FunctionLike | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === promptName) {
      found = node;
      return;
    }
    if (ts.isExportAssignment(node)) {
      const helper = findPromptsHelperCall(node.expression);
      for (const prop of helper?.object.properties ?? []) {
        if (getPropertyName(prop) === promptName) {
          found = getPropertyFunction(prop) ?? undefined;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Resolve the type an injected probe alias stands for.
 *
 * Reads the alias's *declared* type rather than the symbol's, so a probe that
 * resolves to a mapped or conditional type is evaluated rather than handed
 * back as the alias name.
 */
function resolveTypeAlias(
  sourceFile: ts.SourceFile,
  aliasName: string,
  typeChecker: ts.TypeChecker,
): ts.Type | undefined {
  for (const stmt of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === aliasName) {
      return typeChecker.getTypeFromTypeNode(stmt.type);
    }
  }
  return undefined;
}

// #region Helper-shape parsing

/**
 * If `expr` is a call like `prompts({ id }, factory)` whose factory immediately
 * returns an object literal, return that object literal together with the module
 * ID extracted from the options object. Otherwise null.
 */
function findPromptsHelperCall(
  expr: ts.Expression,
): { object: ts.ObjectLiteralExpression; moduleId?: string } | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "prompts")
    return null;
  const factory = expr.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
  if (!factory) return null;
  const object = findReturnObjectInFunctionLike(factory);
  if (!object) return null;
  const first = expr.arguments[0];
  const moduleId =
    first && ts.isObjectLiteralExpression(first)
      ? extractStringProperty(first, "id")
      : undefined;
  return { object, moduleId };
}

function extractStringProperty(
  obj: ts.ObjectLiteralExpression,
  key: string,
): string | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === key &&
      ts.isStringLiteralLike(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return undefined;
}

function getPropertyName(prop: ts.ObjectLiteralElementLike): string | null {
  if (ts.isMethodDeclaration(prop) || ts.isPropertyAssignment(prop)) {
    const name = prop.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (
      ts.isComputedPropertyName(name) &&
      ts.isStringLiteralLike(name.expression)
    ) {
      return name.expression.text;
    }
  } else if (ts.isShorthandPropertyAssignment(prop)) {
    return prop.name.text;
  }
  return null;
}

type FunctionLike =
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

function getPropertyFunction(
  prop: ts.ObjectLiteralElementLike,
): FunctionLike | null {
  if (ts.isMethodDeclaration(prop)) return prop;
  if (ts.isPropertyAssignment(prop)) {
    const init = prop.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return null;
}

/**
 * Resolve binding-array candidates against the file's structure.
 *
 * For each `functionCall` in `value`, walk its `binding` candidates in order
 * and pick the first one that matches the source:
 * - `parameter` candidates match when the file contains the named
 *   `enclosingCall` (e.g. `prompts(({...}) => ...)`) whose first parameter is
 *   a destructured object. The callee is added to that destructure (if not
 *   already present) and the value's `binding` is stripped — the new
 *   functionCall reads its callee from the closure parameter, not a top-level
 *   import.
 * - `import` candidates always match. They collapse the binding to that
 *   single import so ts-proppy's emitter adds the corresponding top-level
 *   import.
 *
 * Returns the (possibly) adjusted source code along with a plain
 * {@link PropValue} ready for ts-proppy.
 */
function resolveBindingsAndAugment(
  sourceCode: string,
  value: ModelPropValue,
): { sourceCode: string; value: PropValue } {
  const sourceFile = ts.createSourceFile(
    "helper-adjust.ts",
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
  );

  // Per-target list of callee names to introduce (deduped, position-sorted
  // later). A target is either an existing destructure to augment or a factory
  // whose (empty) parameter list needs a fresh destructure created.
  const targetAdditions = new Map<DestructureTarget, Set<string>>();

  const resolveCandidate = (
    _fc: Extract<ModelPropValue, { kind: "functionCall" }>,
    candidates: CalleeBinding[],
  ): { binding?: CalleeBinding; viaDestructure?: DestructureTarget } => {
    for (const c of candidates) {
      if (c.kind === "parameter") {
        const dest = findEnclosingCallDestructure(sourceFile, c.enclosingCall);
        if (dest) return { viaDestructure: dest };
      } else if (c.kind === "import") {
        return { binding: c };
      }
    }
    return {};
  };

  const adjusted = mapFunctionCalls(value, fc => {
    if (!fc.binding) return fc as Extract<PropValue, { kind: "functionCall" }>;
    const candidates: CalleeBinding[] = Array.isArray(fc.binding)
      ? fc.binding
      : [fc.binding];
    const result = resolveCandidate(fc, candidates);
    if (result.viaDestructure) {
      const set =
        targetAdditions.get(result.viaDestructure) ?? new Set<string>();
      set.add(fc.callee);
      targetAdditions.set(result.viaDestructure, set);
      const { binding: _drop, ...rest } = fc;
      return rest as Extract<PropValue, { kind: "functionCall" }>;
    }
    if (result.binding) {
      return { ...fc, binding: result.binding } as Extract<
        PropValue,
        { kind: "functionCall" }
      >;
    }
    const { binding: _none, ...rest } = fc;
    return rest as Extract<PropValue, { kind: "functionCall" }>;
  });

  // Build the textual edits, then apply them from latest position to earliest so
  // earlier spans remain valid through the edits.
  const edits = [...targetAdditions.entries()]
    .map(([target, names]) => {
      const existing = new Set<string>();
      for (const el of target.pattern?.elements ?? []) {
        if (ts.isIdentifier(el.name)) existing.add(el.name.text);
      }
      const toAdd = [...names].filter(n => !existing.has(n));
      if (toAdd.length === 0) return null;

      if (target.pattern) {
        // Augment an existing destructure: insert before the `}`.
        const isEmpty = target.pattern.elements.length === 0;
        return {
          end: target.pattern.getEnd(),
          apply: (src: string) => {
            let offset = target.pattern!.getEnd() - 1; // position of `}`
            while (src[offset - 1] === " ") offset--;
            const insertion =
              (isEmpty ? " " : ", ") + toAdd.join(", ") + (isEmpty ? " " : "");
            return src.slice(0, offset) + insertion + src.slice(offset);
          },
        };
      }

      // Create a destructure in the factory's empty parameter list: turn
      // `() => …` into `({ a, b }) => …`.
      const openParen = target.paramOpenParen;
      return {
        end: openParen + 1,
        apply: (src: string) =>
          src.slice(0, openParen + 1) +
          `{ ${toAdd.join(", ")} }` +
          src.slice(openParen + 1),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => b.end - a.end);

  let nextSource = sourceCode;
  for (const edit of edits) nextSource = edit.apply(nextSource);

  return { sourceCode: nextSource, value: adjusted };
}

/**
 * A place to introduce a destructured callee for a `parameter` binding: either
 * an existing object binding pattern to augment, or a factory whose empty
 * parameter list needs a destructure created at `paramOpenParen` (the offset of
 * its `(`).
 */
type DestructureTarget =
  | { pattern: ts.ObjectBindingPattern; paramOpenParen?: undefined }
  | { pattern?: undefined; paramOpenParen: number };

/**
 * Find where to bind a callee against the destructured first parameter of a
 * call matching `enclosingCall` at the top level of `sourceFile`.
 *
 * Returns the existing object binding pattern when the factory already
 * destructures its first parameter, or — when the factory takes no parameters
 * yet (e.g. a freshly-created `() => …` skeleton) — a target describing where to
 * create one. Returns null when no matching call exists or when its first
 * parameter is present but is not an object binding pattern.
 *
 * When `enclosingCall.import` is provided, the callee identifier must resolve
 * to a named import matching that spec.
 */
function findEnclosingCallDestructure(
  sourceFile: ts.SourceFile,
  enclosingCall?: { callee: string; import?: { name: string; from: string } },
): DestructureTarget | null {
  if (!enclosingCall) return null;

  const importOk = enclosingCall.import
    ? sourceFileHasNamedImport(
        sourceFile,
        enclosingCall.import.name,
        enclosingCall.import.from,
      )
    : true;
  if (!importOk) return null;

  let found: DestructureTarget | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === enclosingCall.callee
    ) {
      // The factory is the first function argument — it may follow a leading
      // module-id string (`prompts('id', factory)`).
      const factory = node.arguments.find(
        (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
      );
      if (factory) {
        const param = factory.parameters[0];
        if (param?.name && ts.isObjectBindingPattern(param.name)) {
          found = { pattern: param.name };
          return;
        }
        if (!param) {
          // No parameter yet: create a destructure inside the empty `()`.
          const openParen = sourceFile.text.indexOf(
            "(",
            factory.getStart(sourceFile),
          );
          if (openParen >= 0) {
            found = { paramOpenParen: openParen };
            return;
          }
        }
        // A non-destructure parameter (e.g. `(providers) => …`) isn't a target —
        // fall through so an `import` candidate can match instead.
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceFileHasNamedImport(
  sourceFile: ts.SourceFile,
  name: string,
  from: string,
): boolean {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== from) continue;
    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
      continue;
    for (const el of clause.namedBindings.elements) {
      if (el.name.text === name) return true;
    }
  }
  return false;
}

/** Walk a ModelPropValue tree, transforming each functionCall via `fn`. */
function mapFunctionCalls(
  value: ModelPropValue,
  fn: (
    fc: Extract<ModelPropValue, { kind: "functionCall" }>,
  ) => Extract<PropValue, { kind: "functionCall" }>,
): PropValue {
  switch (value.kind) {
    case "functionCall": {
      const mappedArgs = value.args.map(a => mapFunctionCalls(a, fn));
      return fn({ ...value, args: mappedArgs as ModelPropValue[] });
    }
    case "object": {
      const properties: Record<string, PropValue> = {};
      for (const [k, v] of Object.entries(value.properties))
        properties[k] = mapFunctionCalls(v, fn);
      return { ...value, properties };
    }
    case "array":
    case "tuple":
      return {
        ...value,
        elements: value.elements.map(el => mapFunctionCalls(el, fn)),
      } as PropValue;
    default:
      return value as PropValue;
  }
}

function findReturnObjectInFunctionLike(
  fn: FunctionLike,
): ts.ObjectLiteralExpression | null {
  // Arrow functions with expression bodies: `() => ({ ... })` or `() => obj`.
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const body = ts.isParenthesizedExpression(fn.body)
      ? fn.body.expression
      : fn.body;
    return ts.isObjectLiteralExpression(body) ? body : null;
  }
  // Block bodies: find the first `return { ... }`.
  let result: ts.ObjectLiteralExpression | null = null;
  const visit = (n: ts.Node) => {
    if (result) return;
    if (
      ts.isReturnStatement(n) &&
      n.expression &&
      ts.isObjectLiteralExpression(n.expression)
    ) {
      result = n.expression;
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return result;
}

// #endregion
