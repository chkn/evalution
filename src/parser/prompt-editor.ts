import fs from 'fs/promises';
import ts from 'typescript';
import type { PromptProperty, ModelValue } from './types.ts';
import { KNOWN_PROVIDERS } from '../shared/constants.ts';

export class PromptEditor {
  async updateProperty(filePath: string, property: PromptProperty, newValue: any): Promise<void> {
    if (!property.isEditable) {
      throw new Error(`Property '${property.name}' is not editable`);
    }

    if (!property.valueSpan) {
      throw new Error(`Property '${property.name}' is missing source metadata`);
    }

    // Read source file
    let sourceCode = await fs.readFile(filePath, 'utf-8');

    // For model property with function format, ensure import first
    if (property.name === 'model' && typeof newValue === 'object' && newValue.type === 'function') {
      sourceCode = await this.ensureImport(filePath, newValue.provider, sourceCode);
    }

    // Convert new value to TypeScript source text
    const newSourceText = this.valueToSourceText(newValue, property.name);

    // Replace character range
    const before = sourceCode.substring(0, property.valueSpan.start);
    const after = sourceCode.substring(property.valueSpan.end);
    const newSourceCode = before + newSourceText + after;

    // Write back to file
    await fs.writeFile(filePath, newSourceCode, 'utf-8');
  }

  async addProperty(
    filePath: string,
    functionName: string,
    propertyName: string,
    value: any
  ): Promise<void> {
    let sourceCode = await fs.readFile(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);

    const obj = this.findReturnObject(sourceFile, functionName);
    if (!obj) throw new Error(`Return object not found in function '${functionName}'`);

    const valueText = this.valueToSourceText(value, propertyName);

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
    await fs.writeFile(filePath, sourceCode, 'utf-8');
  }

  async removeProperty(filePath: string, property: PromptProperty): Promise<void> {
    if (!property.fullSpan) {
      throw new Error(`Property '${property.name}' is missing fullSpan metadata`);
    }
    const sourceCode = await fs.readFile(filePath, 'utf-8');
    const newSourceCode =
      sourceCode.slice(0, property.fullSpan.start) +
      sourceCode.slice(property.fullSpan.end);
    await fs.writeFile(filePath, newSourceCode, 'utf-8');
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

  private valueToSourceText(value: any, propertyName: string): string {
    // Handle model property specially
    if (propertyName === 'model') {
      return this.modelToSourceText(value);
    }

    // Handle strings
    if (typeof value === 'string') {
      return JSON.stringify(value);
    }

    // Handle numbers
    if (typeof value === 'number') {
      return value.toString();
    }

    // Handle booleans
    if (typeof value === 'boolean') {
      return value.toString();
    }

    // Handle arrays
    if (Array.isArray(value)) {
      if (propertyName === 'messages') {
        return this.formatMessages(value);
      }
      return JSON.stringify(value, null, 2);
    }

    // Handle objects
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, 2);
    }

    throw new Error(`Unsupported value type for property '${propertyName}'`);
  }

  private modelToSourceText(value: any): string {
    // String format: 'openai/gpt-4o'
    if (typeof value === 'string') {
      return JSON.stringify(value);
    }

    // ModelValue object
    if (typeof value === 'object' && value !== null) {
      const modelValue = value as ModelValue;

      if (modelValue.type === 'string') {
        return JSON.stringify(modelValue.model);
      }

      if (modelValue.type === 'function') {
        const provider = modelValue.provider!;
        const model = modelValue.model;

        // Return function call format (import is handled separately)
        return `${provider}(${JSON.stringify(model)})`;
      }
    }

    throw new Error('Invalid model value format');
  }

  private async ensureImport(filePath: string, provider: string, sourceCode: string): Promise<string> {
    const providerInfo = KNOWN_PROVIDERS[provider as keyof typeof KNOWN_PROVIDERS];
    if (!providerInfo) {
      return sourceCode; // Unknown provider, skip import management
    }

    const importPath = providerInfo.importPath;
    const importStatement = `import { ${provider} } from '${importPath}';`;

    // Check if import already exists
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true
    );

    let hasImport = false;
    const visitNode = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === importPath) {
          // Check if the provider is imported
          const importClause = node.importClause;
          if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
              if (element.name.text === provider) {
                hasImport = true;
                break;
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitNode);
    };
    visitNode(sourceFile);

    // Add import if missing
    if (!hasImport) {
      const lines = sourceCode.split('\n');

      // Find last import statement
      let lastImportIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('import ')) {
          lastImportIndex = i;
        }
      }

      // Insert after last import, or at the beginning
      if (lastImportIndex >= 0) {
        lines.splice(lastImportIndex + 1, 0, importStatement);
      } else {
        lines.unshift(importStatement);
      }

      return lines.join('\n');
    }

    return sourceCode;
  }

  private formatMessages(messages: any[]): string {
    const formatted = messages.map(msg => {
      const role = msg.role ? `role: ${JSON.stringify(msg.role)}` : '';
      const content = msg.content ? `content: ${JSON.stringify(msg.content)}` : '';
      const parts = [role, content].filter(Boolean).join(', ');
      return `      { ${parts} }`;
    }).join(',\n');

    return `[\n${formatted}\n    ]`;
  }
}
