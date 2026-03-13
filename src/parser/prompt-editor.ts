import ts from 'typescript';
import type { ModelProviderInfo, PromptProperty, ModelValue, SourceSpan } from '../shared/types.ts';
import type { FileProvider } from '../providers/file/file-provider.ts';

export class PromptEditor {
  private fileProvider: FileProvider;
  private getKnownProviders: () => Promise<Record<string, ModelProviderInfo>>;

  constructor(fileProvider: FileProvider, getKnownProviders: () => Promise<Record<string, ModelProviderInfo>> = () => Promise.resolve({})) {
    this.fileProvider = fileProvider;
    this.getKnownProviders = getKnownProviders;
  }

  async updateProperty(filePath: string, property: PromptProperty, newValue: any): Promise<void> {
    if (!property.isEditable) {
      throw new Error(`Property '${property.name}' is not editable`);
    }

    if (!property.valueSpan) {
      throw new Error(`Property '${property.name}' is missing source metadata`);
    }

    // Read source file
    let sourceCode = await this.fileProvider.readFile(filePath);

    // For model property with function format, ensure import first
    if (property.name === 'model' && typeof newValue === 'object' && newValue.type === 'function') {
      sourceCode = await this.ensureImport(filePath, newValue.provider, sourceCode);
    }

    // Re-parse the current file to get the live span — guards against stale spans
    // caused by concurrent or sequential saves that already changed the file length.
    const functionName = property.promptId?.slice(property.promptId.lastIndexOf('#') + 1);
    const valueSpan = (functionName
      ? this.findFreshValueSpan(sourceCode, filePath, functionName, property.name)
      : null) ?? property.valueSpan;

    // Convert new value to TypeScript source text
    const newSourceText = this.valueToSourceText(newValue, property.name);

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
    value: any
  ): Promise<void> {
    let sourceCode = await this.fileProvider.readFile(filePath);
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

  private valueToSourceText(value: any, propertyName: string): string {
    // Handle model property specially
    if (propertyName === 'model') {
      return this.modelToSourceText(value);
    }

    // Handle strings
    if (typeof value === 'string') {
      return this.stringToSourceText(value);
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
    const knownProviders = await this.getKnownProviders();
    const providerInfo = knownProviders[provider];
    if (!providerInfo) {
      return sourceCode; // Unknown provider, skip import management
    }

    const importPath = providerInfo.importPath;
    if (!importPath) {
      return sourceCode; // No import path specified, skip import management
    }
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

  private stringToSourceText(value: string): string {
    // Strings containing ${...} must use backticks to preserve interpolation
    if (/\$\{[^}]+\}/.test(value)) {
      return '`' + value.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
    }
    return JSON.stringify(value);
  }

  private formatMessages(messages: any[]): string {
    const formatted = messages.map(msg => {
      const role = msg.role ? `role: ${JSON.stringify(msg.role)}` : '';
      const content = msg.content !== undefined ? `content: ${this.stringToSourceText(msg.content)}` : '';
      const parts = [role, content].filter(Boolean).join(', ');
      return `      { ${parts} }`;
    }).join(',\n');

    return `[\n${formatted}\n    ]`;
  }
}
