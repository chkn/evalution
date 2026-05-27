import ts from 'typescript';
import path from 'path';
import type { PropDefinition, PropValue } from 'ts-proppy';
import {
  updateProperty as applyUpdate,
  addProperty as applyAdd,
  removeProperty as applyRemove,
  extractPropertiesFromObjectLiteral,
  extractPropertiesFromParameters,
} from 'ts-proppy';
import { type FileProvider, LocalFileProvider } from '../../../file-provider.ts';
import type { PromptFileType, ParsedFilePrompt } from '../prompt-file-type.ts';
import type { ModelPropValue, CalleeBinding } from '../../../shared/types.ts';

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

export class TSPromptFileType implements PromptFileType {
  defaultIncludePatterns = ['**/*.prompt.ts', '**/*.promp.ts'];

  private fileProvider: FileProvider;

  constructor(fileProvider: FileProvider = new LocalFileProvider()) {
    this.fileProvider = fileProvider;
  }

  async parsePrompts(files: string[], rootDir: string = ''): Promise<ParsedFilePrompt[]> {
    const results = await Promise.all(
      files.map(async filePath => {
        const sourceCode = await this.fileProvider.readFile(filePath);
        return this.parseFileContent(filePath, sourceCode, rootDir);
      })
    );
    return results.flat();
  }

  async updateProperty(filePath: string, propDef: PropDefinition, value: ModelPropValue, promptId?: string): Promise<void> {
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
    const functionName = promptId?.slice(promptId.lastIndexOf('#') + 1);
    if (functionName) {
      const freshDef = this.findFreshDefinition(sourceCode, filePath, functionName, propDef.name);
      if (freshDef) {
        propDef = { ...propDef, valueSpan: freshDef.valueSpan, fullSpan: freshDef.fullSpan };
      }
    }

    sourceCode = applyUpdate(sourceCode, propDef, resolvedValue);
    await this.fileProvider.writeFile(filePath, sourceCode);
  }

  async removeProperty(filePath: string, propDef: PropDefinition): Promise<void> {
    if (!propDef.fullSpan) {
      throw new Error(`Property '${propDef.name}' is missing fullSpan`);
    }
    const sourceCode = await this.fileProvider.readFile(filePath);
    const newSourceCode = applyRemove(sourceCode, propDef);
    await this.fileProvider.writeFile(filePath, newSourceCode);
  }

  async addProperty(filePath: string, promptName: string, propertyName: string, value: ModelPropValue): Promise<void> {
    let sourceCode = await this.fileProvider.readFile(filePath);

    const adjusted = resolveBindingsAndAugment(sourceCode, value);
    sourceCode = adjusted.sourceCode;
    const resolvedValue = adjusted.value;

    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);
    const returnObj = this.findReturnObjectInSource(sourceFile, promptName);
    if (!returnObj) throw new Error(`Return object not found in function '${promptName}'`);

    const extracted = extractPropertiesFromObjectLiteral(returnObj, undefined, sourceFile);
    sourceCode = applyAdd(sourceCode, extracted, propertyName, resolvedValue);
    await this.fileProvider.writeFile(filePath, sourceCode);
  }

  async renamePrompt(filePath: string, oldName: string, newName: string): Promise<void> {
    const sourceCode = await this.fileProvider.readFile(filePath);
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    let nameStart = -1;
    let nameEnd = -1;

    const visit = (node: ts.Node) => {
      if (nameStart >= 0) return;
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === oldName
      ) {
        nameStart = node.name.getStart(sourceFile);
        nameEnd = node.name.getEnd();
        return;
      }
      if (ts.isExportAssignment(node)) {
        const obj = findPromptsHelperObject(node.expression);
        if (obj) {
          for (const prop of obj.properties) {
            if (getPropertyName(prop) === oldName) {
              const nameNode = (prop as ts.MethodDeclaration | ts.PropertyAssignment).name;
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

    if (nameStart < 0) throw new Error(`Function '${oldName}' not found in ${filePath}`);

    const newSource = sourceCode.slice(0, nameStart) + newName + sourceCode.slice(nameEnd);
    await this.fileProvider.writeFile(filePath, newSource);
  }

  async loadConfig(filePath: string, promptName: string, params: any[]): Promise<any> {
    const module = await this.fileProvider.import(filePath);
    let fn = module[promptName];

    // Fall back to the prompts() helper shape: `export default prompts(factory)`
    // resolves to a function that returns an object of prompt methods.
    if (typeof fn !== 'function' && typeof module.default === 'function') {
      const obj = module.default();
      if (obj && typeof obj[promptName] === 'function') fn = obj[promptName].bind(obj);
    }

    if (typeof fn !== 'function') {
      throw new Error(`Function '${promptName}' not found in ${filePath}`);
    }

    const config = fn(...params);

    if (!config || typeof config !== 'object') {
      throw new Error(`'${promptName}' did not return a valid config object`);
    }

    return config;
  }

  // #region Parsing

  private parseFileContent(filePath: string, sourceCode: string, rootDir: string): ParsedFilePrompt[] {
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ESNext, true);
    const prompts: ParsedFilePrompt[] = [];

    const visitNode = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const isExported = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          const prompt = this.parseFunctionDeclaration(node, sourceFile, filePath, rootDir);
          if (prompt) prompts.push(prompt);
        }
      } else if (ts.isExportAssignment(node)) {
        const obj = findPromptsHelperObject(node.expression);
        if (obj) {
          for (const prop of obj.properties) {
            const parsed = this.parseHelperProperty(prop, sourceFile, filePath, rootDir);
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
  ): ParsedFilePrompt | null {
    const name = getPropertyName(prop);
    if (!name) return null;

    const fn = getPropertyFunction(prop);
    if (!fn) return null;

    const returnObject = findReturnObjectInFunctionLike(fn);
    if (!returnObject) return null;

    const functionParameters = extractPropertiesFromParameters(fn.parameters, sourceFile).definitions;
    const relativeFilePath = rootDir ? path.relative(rootDir, filePath) : filePath;
    const extractedProps = extractPropertiesFromObjectLiteral(returnObject, undefined, sourceFile);
    const treePath = relativeFilePath.split('/').filter(Boolean);

    return {
      id: `${relativeFilePath}#${name}`,
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
    rootDir: string
  ): ParsedFilePrompt | null {
    if (!node.name) return null;

    const functionName = node.name.text;
    const functionParameters = extractPropertiesFromParameters(node.parameters, sourceFile).definitions;
    const returnObject = this.findReturnObjectInFunction(node);
    if (!returnObject) return null;

    const relativeFilePath = rootDir ? path.relative(rootDir, filePath) : filePath;
    const promptId = `${relativeFilePath}#${functionName}`;
    const extractedProps = extractPropertiesFromObjectLiteral(returnObject, undefined, sourceFile);
    const treePath = relativeFilePath.split('/').filter(Boolean);

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
    propertyName: string
  ): PropDefinition | null {
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);
    const returnObj = this.findReturnObjectInSource(sourceFile, functionName);
    if (!returnObj) return null;

    const extracted = extractPropertiesFromObjectLiteral(returnObj, undefined, sourceFile);
    return extracted.definitions.find(d => d.name === propertyName) ?? null;
  }

  private findReturnObjectInFunction(node: ts.FunctionDeclaration): ts.ObjectLiteralExpression | null {
    let returnObject: ts.ObjectLiteralExpression | null = null;

    const visitNode = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && n.expression) {
        if (ts.isObjectLiteralExpression(n.expression)) {
          returnObject = n.expression;
        }
      } else if (ts.isArrowFunction(n) && ts.isObjectLiteralExpression(n.body)) {
        returnObject = n.body;
      }
      if (!returnObject) ts.forEachChild(n, visitNode);
    };

    if (node.body) visitNode(node.body);
    return returnObject;
  }

  private findReturnObjectInSource(
    sourceFile: ts.SourceFile,
    functionName: string
  ): ts.ObjectLiteralExpression | null {
    let returnObj: ts.ObjectLiteralExpression | null = null;

    const visitFunc = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
        returnObj = this.findReturnObjectInFunction(node);
        return;
      }
      if (ts.isExportAssignment(node)) {
        const obj = findPromptsHelperObject(node.expression);
        if (obj) {
          for (const prop of obj.properties) {
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

// #region Helper-shape parsing

/**
 * If `expr` is a call like `prompts(factory)` whose factory immediately returns
 * an object literal, return that object literal. Otherwise null.
 */
function findPromptsHelperObject(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'prompts') return null;
  const factory = expr.arguments[0];
  if (!factory) return null;
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return null;
  return findReturnObjectInFunctionLike(factory);
}

function getPropertyName(prop: ts.ObjectLiteralElementLike): string | null {
  if (ts.isMethodDeclaration(prop) || ts.isPropertyAssignment(prop)) {
    const name = prop.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  } else if (ts.isShorthandPropertyAssignment(prop)) {
    return prop.name.text;
  }
  return null;
}

type FunctionLike = ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function getPropertyFunction(prop: ts.ObjectLiteralElementLike): FunctionLike | null {
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
  const sourceFile = ts.createSourceFile('helper-adjust.ts', sourceCode, ts.ScriptTarget.Latest, true);

  // Per-destructure list of names to add (deduped, position-sorted later).
  const destructureAdditions = new Map<ts.ObjectBindingPattern, Set<string>>();

  const resolveCandidate = (
    fc: Extract<ModelPropValue, { kind: 'functionCall' }>,
    candidates: CalleeBinding[],
  ): { binding?: CalleeBinding; viaDestructure?: ts.ObjectBindingPattern } => {
    for (const c of candidates) {
      if (c.kind === 'parameter') {
        const dest = findEnclosingCallDestructure(sourceFile, c.enclosingCall);
        if (dest) return { viaDestructure: dest };
      } else if (c.kind === 'import') {
        return { binding: c };
      }
    }
    return {};
  };

  const adjusted = mapFunctionCalls(value, fc => {
    if (!fc.binding) return fc as Extract<PropValue, { kind: 'functionCall' }>;
    const candidates: CalleeBinding[] = Array.isArray(fc.binding) ? fc.binding : [fc.binding];
    const result = resolveCandidate(fc, candidates);
    if (result.viaDestructure) {
      const set = destructureAdditions.get(result.viaDestructure) ?? new Set<string>();
      set.add(fc.callee);
      destructureAdditions.set(result.viaDestructure, set);
      const { binding: _drop, ...rest } = fc;
      return rest as Extract<PropValue, { kind: 'functionCall' }>;
    }
    if (result.binding) {
      return { ...fc, binding: result.binding } as Extract<PropValue, { kind: 'functionCall' }>;
    }
    const { binding: _none, ...rest } = fc;
    return rest as Extract<PropValue, { kind: 'functionCall' }>;
  });

  // Apply destructure augmentations from latest position to earliest so earlier
  // spans remain valid through the textual edits.
  const augmentations = [...destructureAdditions.entries()]
    .map(([dest, names]) => {
      const existing = new Set<string>();
      for (const el of dest.elements) {
        if (ts.isIdentifier(el.name)) existing.add(el.name.text);
      }
      const toAdd = [...names].filter(n => !existing.has(n));
      return { dest, toAdd };
    })
    .filter(a => a.toAdd.length > 0)
    .sort((a, b) => b.dest.getEnd() - a.dest.getEnd());

  let nextSource = sourceCode;
  for (const { dest, toAdd } of augmentations) {
    let closeOffset = dest.getEnd() - 1; // position of `}`
    while (nextSource[closeOffset - 1] === ' ') closeOffset--;
    const isEmpty = dest.elements.length === 0;
    const insertion = (isEmpty ? ' ' : ', ') + toAdd.join(', ') + (isEmpty ? ' ' : '');
    nextSource = nextSource.slice(0, closeOffset) + insertion + nextSource.slice(closeOffset);
  }

  return { sourceCode: nextSource, value: adjusted };
}

/**
 * Find the destructured first parameter of a call matching `enclosingCall` at
 * the top level of `sourceFile`. Returns null when no such call exists or when
 * its first parameter is not an object binding pattern.
 *
 * When `enclosingCall.import` is provided, the callee identifier must resolve
 * to a named import matching that spec.
 */
function findEnclosingCallDestructure(
  sourceFile: ts.SourceFile,
  enclosingCall?: { callee: string; import?: { name: string; from: string } },
): ts.ObjectBindingPattern | null {
  if (!enclosingCall) return null;

  const importOk = enclosingCall.import
    ? sourceFileHasNamedImport(sourceFile, enclosingCall.import.name, enclosingCall.import.from)
    : true;
  if (!importOk) return null;

  let found: ts.ObjectBindingPattern | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === enclosingCall.callee
    ) {
      const factory = node.arguments[0];
      if (factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
        const param = factory.parameters[0];
        if (param?.name && ts.isObjectBindingPattern(param.name)) {
          found = param.name;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceFileHasNamedImport(sourceFile: ts.SourceFile, name: string, from: string): boolean {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== from) continue;
    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const el of clause.namedBindings.elements) {
      if (el.name.text === name) return true;
    }
  }
  return false;
}

/** Walk a ModelPropValue tree, transforming each functionCall via `fn`. */
function mapFunctionCalls(
  value: ModelPropValue,
  fn: (fc: Extract<ModelPropValue, { kind: 'functionCall' }>) => Extract<PropValue, { kind: 'functionCall' }>,
): PropValue {
  switch (value.kind) {
    case 'functionCall': {
      const mappedArgs = value.args.map(a => mapFunctionCalls(a, fn));
      return fn({ ...value, args: mappedArgs as ModelPropValue[] });
    }
    case 'object': {
      const properties: Record<string, PropValue> = {};
      for (const [k, v] of Object.entries(value.properties)) properties[k] = mapFunctionCalls(v, fn);
      return { ...value, properties };
    }
    case 'array':
    case 'tuple':
      return { ...value, elements: value.elements.map(el => mapFunctionCalls(el, fn)) } as PropValue;
    default:
      return value as PropValue;
  }
}

function findReturnObjectInFunctionLike(
  fn: FunctionLike,
): ts.ObjectLiteralExpression | null {
  // Arrow functions with expression bodies: `() => ({ ... })` or `() => obj`.
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const body = ts.isParenthesizedExpression(fn.body) ? fn.body.expression : fn.body;
    return ts.isObjectLiteralExpression(body) ? body : null;
  }
  // Block bodies: find the first `return { ... }`.
  let result: ts.ObjectLiteralExpression | null = null;
  const visit = (n: ts.Node) => {
    if (result) return;
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
      result = n.expression;
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return result;
}

// #endregion
