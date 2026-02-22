import ts from 'typescript';
import type { ParsedPrompt, FunctionParameter, PromptProperty, ModelValue } from './types.ts';
import fs from 'fs';
import path from 'path';

export class PromptParser {
  private program: ts.Program;
  private filePathsMap: Map<string, ts.SourceFile>;
  private rootDir: string;

  constructor(filePaths: string[], rootDir: string = '') {
    this.rootDir = rootDir;
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: false,
      strict: false,
    };

    this.program = ts.createProgram(filePaths, compilerOptions);
    this.filePathsMap = new Map();

    for (const filePath of filePaths) {
      const sourceFile = this.program.getSourceFile(filePath);
      if (sourceFile) {
        this.filePathsMap.set(filePath, sourceFile);
      }
    }
  }

  parseFile(filePath: string): ParsedPrompt[] {
    const sourceFile = this.filePathsMap.get(filePath) || this.program.getSourceFile(filePath);
    if (!sourceFile) {
      return [];
    }

    const prompts: ParsedPrompt[] = [];

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

  parseAll(): ParsedPrompt[] {
    const allPrompts: ParsedPrompt[] = [];

    for (const [filePath, sourceFile] of this.filePathsMap) {
      const prompts = this.parseFile(filePath);
      allPrompts.push(...prompts);
    }

    return allPrompts;
  }

  private parseFunctionDeclaration(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string
  ): ParsedPrompt | null {
    if (!node.name) return null;

    const functionName = node.name.text;
    const functionParameters = this.parseFunctionParameters(node, sourceFile);

    // Find return statement or expression
    const returnObject = this.findReturnObject(node);
    if (!returnObject) return null;

    const properties = this.parseObjectLiteral(returnObject, sourceFile, functionParameters.map(p => p.name));

    const relativeFilePath = this.rootDir ? path.relative(this.rootDir, filePath) : filePath;

    return {
      id: `${relativeFilePath}#${functionName}`,
      name: functionName,
      functionParameters,
      properties,
      metadata: {
        filePath,
        sourceFile: filePath,
      },
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
        // Handle destructured parameters like { name, age }
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
    paramNames: string[]
  ): Record<string, PromptProperty> {
    const properties: Record<string, PromptProperty> = {};

    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText(sourceFile);
        const value = prop.initializer;

        const propertyInfo = this.parsePropertyValue(value, sourceFile, paramNames);

        const fullText = sourceFile.getFullText();
        let fullEnd = prop.getEnd();
        if (fullText[fullEnd] === ',') fullEnd++;

        properties[name] = {
          name,
          value: propertyInfo.value,
          isEditable: propertyInfo.isEditable,
          hasParameterTokens: propertyInfo.hasParameterTokens,
          sourceText: value.getText(sourceFile),
          valueSpan: {
            start: value.getStart(sourceFile),
            end: value.getEnd(),
          },
          fullSpan: {
            start: prop.getFullStart(),
            end: fullEnd,
          },
        };
      }
    }

    return properties;
  }

  private parsePropertyValue(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    paramNames: string[]
  ): { value: any; isEditable: boolean; hasParameterTokens: boolean } {
    // Handle template literals
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const { value, hasTokens } = this.parseTemplateLiteral(node, sourceFile, paramNames);
      return { value, isEditable: true, hasParameterTokens: hasTokens };
    }

    // Handle binary expressions (concatenation, arithmetic)
    if (ts.isBinaryExpression(node)) {
      const { value, hasTokens } = this.parseBinaryExpression(node, sourceFile, paramNames);
      return { value, isEditable: true, hasParameterTokens: hasTokens };
    }

    // Handle call expressions (like openai('gpt-4'))
    if (ts.isCallExpression(node)) {
      const result = this.parseCallExpression(node, sourceFile, paramNames);
      if (result) {
        return result;
      }
    }

    // Handle identifiers (direct parameter reference)
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (paramNames.includes(name)) {
        return { value: `\${${name}}`, isEditable: false, hasParameterTokens: true };
      }
    }

    // Handle literals
    if (ts.isStringLiteral(node)) {
      return { value: node.text, isEditable: true, hasParameterTokens: false };
    }

    if (ts.isNumericLiteral(node)) {
      return { value: parseFloat(node.text), isEditable: true, hasParameterTokens: false };
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return { value: true, isEditable: true, hasParameterTokens: false };
    }

    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return { value: false, isEditable: true, hasParameterTokens: false };
    }

    // Handle arrays
    if (ts.isArrayLiteralExpression(node)) {
      const elements = node.elements.map(el => {
        if (ts.isObjectLiteralExpression(el)) {
          return this.parseSimpleObject(el, sourceFile, paramNames);
        }
        return this.parsePropertyValue(el, sourceFile, paramNames).value;
      });
      const hasTokens = elements.some(el =>
        typeof el === 'object' && el !== null && this.objectHasTokens(el)
      );
      return { value: elements, isEditable: true, hasParameterTokens: hasTokens };
    }

    // Handle object literals
    if (ts.isObjectLiteralExpression(node)) {
      const obj = this.parseSimpleObject(node, sourceFile, paramNames);
      return { value: obj, isEditable: true, hasParameterTokens: this.objectHasTokens(obj) };
    }

    // Default: complex/computed expression
    return { value: node.getText(sourceFile), isEditable: false, hasParameterTokens: false };
  }

  private parseTemplateLiteral(
    node: ts.TemplateLiteral,
    sourceFile: ts.SourceFile,
    paramNames: string[]
  ): { value: string; hasTokens: boolean } {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return { value: node.text, hasTokens: false };
    }

    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      let hasTokens = false;

      for (const span of node.templateSpans) {
        const expr = span.expression;
        if (ts.isIdentifier(expr) && paramNames.includes(expr.text)) {
          result += `\${${expr.text}}`;
          hasTokens = true;
        } else {
          result += `\${${expr.getText(sourceFile)}}`;
          hasTokens = true;
        }
        result += span.literal.text;
      }

      return { value: result, hasTokens };
    }

    return { value: '', hasTokens: false };
  }

  private parseBinaryExpression(
    node: ts.BinaryExpression,
    sourceFile: ts.SourceFile,
    paramNames: string[]
  ): { value: string; hasTokens: boolean } {
    const left = this.getBinaryOperand(node.left, sourceFile, paramNames);
    const right = this.getBinaryOperand(node.right, sourceFile, paramNames);
    const operator = node.operatorToken.getText(sourceFile);

    const hasTokens = left.hasTokens || right.hasTokens;

    // Handle string concatenation
    if (operator === '+' && (typeof left.value === 'string' || typeof right.value === 'string')) {
      return { value: `${left.value}${right.value}`, hasTokens };
    }

    // Handle arithmetic
    return { value: `${left.value}${operator}${right.value}`, hasTokens };
  }

  private getBinaryOperand(
    node: ts.Expression,
    sourceFile: ts.SourceFile,
    paramNames: string[]
  ): { value: string; hasTokens: boolean } {
    if (ts.isStringLiteral(node)) {
      return { value: node.text, hasTokens: false };
    }

    if (ts.isNumericLiteral(node)) {
      return { value: node.text, hasTokens: false };
    }

    if (ts.isIdentifier(node) && paramNames.includes(node.text)) {
      return { value: `\${${node.text}}`, hasTokens: true };
    }

    if (ts.isBinaryExpression(node)) {
      return this.parseBinaryExpression(node, sourceFile, paramNames);
    }

    return { value: node.getText(sourceFile), hasTokens: false };
  }

  private parseCallExpression(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    paramNames: string[]
  ): { value: ModelValue; isEditable: boolean; hasParameterTokens: boolean } | null {
    const expression = node.expression;

    // Check if it's a provider function call like openai('gpt-4')
    if (ts.isIdentifier(expression)) {
      const provider = expression.text;

      if (node.arguments.length > 0) {
        const firstArg = node.arguments[0];

        if (ts.isStringLiteral(firstArg)) {
          const model = firstArg.text;
          return {
            value: { type: 'function', provider, model },
            isEditable: true,
            hasParameterTokens: false,
          };
        }

        if (ts.isIdentifier(firstArg) && paramNames.includes(firstArg.text)) {
          const model = `\${${firstArg.text}}`;
          return {
            value: { type: 'function', provider, model, hasParameterTokens: true },
            isEditable: true,
            hasParameterTokens: true,
          };
        }
      }
    }

    return null;
  }

  private parseSimpleObject(
    node: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    paramNames: string[]
  ): any {
    const obj: any = {};

    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = prop.name.getText(sourceFile);
        const valueInfo = this.parsePropertyValue(prop.initializer, sourceFile, paramNames);
        obj[key] = valueInfo.value;
      }
    }

    return obj;
  }

  private objectHasTokens(obj: any): boolean {
    if (typeof obj === 'string') {
      return obj.includes('${');
    }

    if (Array.isArray(obj)) {
      return obj.some(item => this.objectHasTokens(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj).some(val => this.objectHasTokens(val));
    }

    return false;
  }

  private evaluateLiteral(node: ts.Expression): any {
    if (ts.isStringLiteral(node)) {
      return node.text;
    }

    if (ts.isNumericLiteral(node)) {
      return parseFloat(node.text);
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }

    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }

    return undefined;
  }
}
