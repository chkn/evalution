import ts from 'typescript';
import type { FilePromptProviderOptions } from '../prompt/file/file-prompt-provider.ts';
import type { ParsedPrompt, FunctionParameter, PromptProperty } from '../shared/types.ts';
import { parseValueFromExpression } from 'ts-proppy';
import path from 'path';

/** Metadata attached to prompts that originate from a file on disk. */
export interface FilePromptMetadata {
  /** Path to the source file relative to the {@link FilePromptProviderOptions.rootDir}. */
  relativeFilePath: string
}

/**
 * A {@link ParsedPrompt} produced by the file-based parser, with
 * {@link FilePromptMetadata} guaranteed to be present on `metadata`.
 */
export interface ParsedFilePrompt extends ParsedPrompt {
  metadata: FilePromptMetadata;
}

/**
 * Read-only view of a parsed prompt tree, obtained via
 * {@link PromptFileType.createParser}.
 */
export interface PromptFileParser {
  /** Parses every file known to this parser and returns all discovered prompts. */
  parseAll(): ParsedFilePrompt[];

  /**
   * Parses a single file and returns the prompts it defines.
   * @param filePath - Absolute path to the file to parse.
   */
  parseFile(filePath: string): ParsedFilePrompt[];
}

export class PromptParser implements PromptFileParser {
  private filePathsMap: Map<string, ts.SourceFile>;
  private rootDir: string;

  static async create(fileContents: readonly (readonly [string, string | Promise<string>])[], rootDir: string = ''): Promise<PromptParser> {
    const filePathsMap = new Map();
    await Promise.all(fileContents.map(async ([filePath, content]) => {
      const sourceFile = ts.createSourceFile(
        filePath,
        await content,
        ts.ScriptTarget.ESNext,
        true,
      );
      filePathsMap.set(filePath, sourceFile);
    }));
    return new PromptParser(filePathsMap, rootDir);
  }

  constructor(filePathsMap: Map<string, ts.SourceFile>, rootDir: string = '') {
    this.filePathsMap = filePathsMap;
    this.rootDir = rootDir;
  }

  parseFile(filePath: string): ParsedFilePrompt[] {
    const sourceFile = this.filePathsMap.get(filePath);
    if (!sourceFile) {
      return [];
    }

    const prompts: ParsedFilePrompt[] = [];

    const visitNode = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const isExported = node.modifiers?.some(
          (mod) => mod.kind === ts.SyntaxKind.ExportKeyword
        );

        if (isExported) {
          const prompt = this.parseFunctionDeclaration(node, sourceFile, filePath);
          if (prompt) {
            prompts.push(prompt);
          }
        }
      }

      ts.forEachChild(node, visitNode);
    };

    visitNode(sourceFile);
    return prompts;
  }

  parseAll(): ParsedFilePrompt[] {
    const allPrompts: ParsedFilePrompt[] = [];

    for (const filePath of this.filePathsMap.keys()) {
      const prompts = this.parseFile(filePath);
      allPrompts.push(...prompts);
    }

    return allPrompts;
  }

  private parseFunctionDeclaration(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string
  ): ParsedFilePrompt | null {
    if (!node.name) return null;

    const functionName = node.name.text;
    const functionParameters = this.parseFunctionParameters(node, sourceFile);

    const returnObject = this.findReturnObject(node);
    if (!returnObject) return null;

    const relativeFilePath = this.rootDir ? path.relative(this.rootDir, filePath) : filePath;

    const promptId = `${relativeFilePath}#${functionName}`;
    const properties = this.parseObjectLiteral(returnObject, sourceFile, promptId);
    const treePath = relativeFilePath.split('/').filter(Boolean);

    return {
      id: promptId,
      name: functionName,
      functionParameters,
      properties,
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
        let defaultValue: any = undefined;

        if (param.initializer) {
          defaultValue = this.evaluateLiteral(param.initializer);
        }

        parameters.push({ name, type, defaultValue });
      } else if (ts.isObjectBindingPattern(param.name)) {
        const bindingPattern = param.name;
        const type = param.type ? param.type.getText(sourceFile) : undefined;

        for (const element of bindingPattern.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const name = element.name.text;
            let defaultValue: any = undefined;

            if (element.initializer) {
              defaultValue = this.evaluateLiteral(element.initializer);
            }

            parameters.push({ name, type, defaultValue });
          }
        }
      }
    }

    return parameters;
  }

  private findReturnObject(node: ts.FunctionDeclaration): ts.ObjectLiteralExpression | null {
    let returnObject: ts.ObjectLiteralExpression | null = null;

    const visitNode = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && n.expression) {
        if (ts.isObjectLiteralExpression(n.expression)) {
          returnObject = n.expression;
        }
      } else if (ts.isArrowFunction(n) && ts.isObjectLiteralExpression(n.body)) {
        returnObject = n.body;
      }

      if (!returnObject) {
        ts.forEachChild(n, visitNode);
      }
    };

    if (node.body) {
      visitNode(node.body);
    }

    return returnObject;
  }

  private parseObjectLiteral(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    promptId?: string
  ): Record<string, PromptProperty> {
    const properties: Record<string, PromptProperty> = {};

    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText(sourceFile);
        const initializer = prop.initializer;

        const value = parseValueFromExpression(initializer as ts.Expression, sourceFile);

        const fullText = sourceFile.getFullText();
        let fullEnd = prop.getEnd();
        if (fullText[fullEnd] === ',') fullEnd++;

        properties[name] = {
          name,
          value,
          isEditable: value.kind !== 'raw' && !(value.kind === 'functionCall' && !value.import),
          sourceText: initializer.getText(sourceFile),
          valueSpan: {
            start: initializer.getStart(sourceFile),
            end: initializer.getEnd(),
          },
          fullSpan: {
            start: prop.getFullStart(),
            end: fullEnd,
          },
          promptId,
        };
      }
    }

    return properties;
  }

  private evaluateLiteral(node: ts.Expression): any {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return parseFloat(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    return undefined;
  }
}
