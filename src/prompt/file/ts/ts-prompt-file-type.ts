import ts from 'typescript';
import path from 'path';
import type { PropDefinition, PropValue } from 'ts-proppy';
import {
  updateProperty as applyUpdate,
  addProperty as applyAdd,
  removeProperty as applyRemove,
  extractPropertiesFromObjectLiteral,
} from 'ts-proppy';
import { type FileProvider, LocalFileProvider } from '../../../file-provider.ts';
import type { PromptFileType, ParsedFilePrompt } from '../prompt-file-type.ts';
import type { FunctionParameter } from '../../../shared/types.ts';

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

  async updateProperty(filePath: string, propDef: PropDefinition, value: PropValue, promptId?: string): Promise<void> {
    if (!propDef.valueSpan) {
      throw new Error(`Property '${propDef.name}' is missing valueSpan`);
    }

    let sourceCode = await this.fileProvider.readFile(filePath);

    // Re-parse to get fresh spans (guards against stale spans from concurrent saves)
    const functionName = promptId?.slice(promptId.lastIndexOf('#') + 1);
    if (functionName) {
      const freshDef = this.findFreshDefinition(sourceCode, filePath, functionName, propDef.name);
      if (freshDef) {
        propDef = { ...propDef, valueSpan: freshDef.valueSpan, fullSpan: freshDef.fullSpan };
      }
    }

    sourceCode = applyUpdate(sourceCode, propDef, value);
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

  async addProperty(filePath: string, promptName: string, propertyName: string, value: PropValue): Promise<void> {
    let sourceCode = await this.fileProvider.readFile(filePath);
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    const returnObj = this.findReturnObjectInSource(sourceFile, promptName);
    if (!returnObj) throw new Error(`Return object not found in function '${promptName}'`);

    const extracted = extractPropertiesFromObjectLiteral(returnObj, undefined, sourceFile);
    sourceCode = applyAdd(sourceCode, extracted, propertyName, value);
    await this.fileProvider.writeFile(filePath, sourceCode);
  }

  async renamePrompt(filePath: string, oldName: string, newName: string): Promise<void> {
    const sourceCode = await this.fileProvider.readFile(filePath);
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    let nameStart = -1;
    let nameEnd = -1;

    const visit = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === oldName
      ) {
        nameStart = node.name.getStart(sourceFile);
        nameEnd = node.name.getEnd();
        return;
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
    const fn = module[promptName];

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
      }
      ts.forEachChild(node, visitNode);
    };

    visitNode(sourceFile);
    return prompts;
  }

  private parseFunctionDeclaration(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    rootDir: string
  ): ParsedFilePrompt | null {
    if (!node.name) return null;

    const functionName = node.name.text;
    const functionParameters = this.parseFunctionParameters(node, sourceFile);
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

  private parseFunctionParameters(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): FunctionParameter[] {
    const parameters: FunctionParameter[] = [];

    for (const param of node.parameters) {
      if (ts.isIdentifier(param.name)) {
        const name = param.name.text;
        const type = param.type ? param.type.getText(sourceFile) : undefined;
        const defaultValue = param.initializer ? this.evaluateLiteral(param.initializer) : undefined;
        parameters.push({ name, type, defaultValue });
      } else if (ts.isObjectBindingPattern(param.name)) {
        const type = param.type ? param.type.getText(sourceFile) : undefined;
        for (const element of param.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const name = element.name.text;
            const defaultValue = element.initializer ? this.evaluateLiteral(element.initializer) : undefined;
            parameters.push({ name, type, defaultValue });
          }
        }
      }
    }

    return parameters;
  }

  private evaluateLiteral(node: ts.Expression): any {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return parseFloat(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    return undefined;
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
      if (!returnObj) ts.forEachChild(node, visitFunc);
    };
    visitFunc(sourceFile);

    return returnObj;
  }
  // #endregion
}
