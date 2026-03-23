import ts from 'typescript';
import type { PropValue } from 'ts-proppy';
import { valueToSourceText, collectImports, ensureImport } from 'ts-proppy';
import type { PromptProperty, SourceSpan } from '../shared/types.ts';
import type { FileProvider } from '../server/file-provider.ts';

export class PromptEditor {
  private fileProvider: FileProvider;

  constructor(fileProvider: FileProvider) {
    this.fileProvider = fileProvider;
  }

  async updateProperty(filePath: string, property: PromptProperty, newValue: PropValue): Promise<void> {
    if (!property.isEditable) {
      throw new Error(`Property '${property.name}' is not editable`);
    }

    if (!property.valueSpan) {
      throw new Error(`Property '${property.name}' is missing source metadata`);
    }

    // Read source file
    let sourceCode = await this.fileProvider.readFile(filePath);

    // Ensure any imports needed by the value
    for (const imp of collectImports(newValue)) {
      sourceCode = ensureImport(sourceCode, imp, filePath);
    }

    // Re-parse the current file to get the live span — guards against stale spans
    // caused by concurrent or sequential saves that already changed the file length.
    const functionName = property.promptId?.slice(property.promptId.lastIndexOf('#') + 1);
    const valueSpan = (functionName
      ? this.findFreshValueSpan(sourceCode, filePath, functionName, property.name)
      : null) ?? property.valueSpan;

    // Convert new value to TypeScript source text
    const newSourceText = valueToSourceText(newValue);

    // Replace character range
    const before = sourceCode.substring(0, valueSpan.start);
    const after = sourceCode.substring(valueSpan.end);
    const newSourceCode = before + newSourceText + after;

    // Write back to file
    await this.fileProvider.writeFile(filePath, newSourceCode);
  }

  private findFreshValueSpan(
    sourceCode: string,
    filePath: string,
    functionName: string,
    propertyName: string
  ): SourceSpan | null {
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    let result: SourceSpan | null = null;

    const visitReturn = (node: ts.Node) => {
      if (result) return;
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        ts.isObjectLiteralExpression(node.expression)
      ) {
        for (const prop of node.expression.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name.getText(sourceFile) === propertyName) {
            result = { start: prop.initializer.getStart(sourceFile), end: prop.initializer.getEnd() };
            return;
          }
        }
      }
      ts.forEachChild(node, visitReturn);
    };

    const visitNode = (node: ts.Node) => {
      if (result) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body) {
        visitReturn(node.body);
        return;
      }
      ts.forEachChild(node, visitNode);
    };
    visitNode(sourceFile);

    return result;
  }

  async addProperty(
    filePath: string,
    functionName: string,
    propertyName: string,
    value: PropValue
  ): Promise<void> {
    let sourceCode = await this.fileProvider.readFile(filePath);

    // Ensure any imports needed by the value
    for (const imp of collectImports(value)) {
      sourceCode = ensureImport(sourceCode, imp, filePath);
    }

    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    const obj = this.findReturnObject(sourceFile, functionName);
    if (!obj) throw new Error(`Return object not found in function '${functionName}'`);

    const valueText = valueToSourceText(value);

    // Derive indentation from the first existing property, defaulting to 4 spaces
    let indent = '    ';
    if (obj.properties.length > 0) {
      const firstProp = obj.properties[0];
      const propPos = firstProp.getStart(sourceFile);
      let lineStart = propPos;
      while (lineStart > 0 && sourceCode[lineStart - 1] !== '\n') lineStart--;
      indent = sourceCode.slice(lineStart, propPos);
    }

    let insertPos: number;
    let insertText: string;

    if (obj.properties.length > 0) {
      // Insert after the last property's trailing comma
      const lastProp = obj.properties[obj.properties.length - 1];
      insertPos = lastProp.getEnd();
      if (sourceCode[insertPos] === ',') insertPos++;
      insertText = `\n${indent}${propertyName}: ${valueText},`;
    } else {
      // Empty return object — insert between { }
      insertPos = obj.getStart(sourceFile) + 1;
      insertText = `\n${indent}${propertyName}: ${valueText},\n`;
    }

    sourceCode = sourceCode.slice(0, insertPos) + insertText + sourceCode.slice(insertPos);
    await this.fileProvider.writeFile(filePath, sourceCode);
  }

  async renameFunction(filePath: string, oldName: string, newName: string): Promise<void> {
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

  async removeProperty(filePath: string, property: PromptProperty): Promise<void> {
    if (!property.fullSpan) {
      throw new Error(`Property '${property.name}' is missing fullSpan metadata`);
    }
    const sourceCode = await this.fileProvider.readFile(filePath);
    const newSourceCode =
      sourceCode.slice(0, property.fullSpan.start) +
      sourceCode.slice(property.fullSpan.end);
    await this.fileProvider.writeFile(filePath, newSourceCode);
  }

  private findReturnObject(
    sourceFile: ts.SourceFile,
    functionName: string
  ): ts.ObjectLiteralExpression | null {
    let returnObj: ts.ObjectLiteralExpression | null = null;

    const visitFunc = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
        const visitReturn = (n: ts.Node) => {
          if (
            ts.isReturnStatement(n) &&
            n.expression &&
            ts.isObjectLiteralExpression(n.expression)
          ) {
            returnObj = n.expression;
          }
          if (!returnObj) ts.forEachChild(n, visitReturn);
        };
        if (node.body) visitReturn(node.body);
        return;
      }
      if (!returnObj) ts.forEachChild(node, visitFunc);
    };
    visitFunc(sourceFile);

    return returnObj;
  }
}
