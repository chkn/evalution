import ts from 'typescript';
import fs from 'fs';
import path from 'path';

export interface CallSettingInfo {
  name: string;
  type: string;
  defaultValue: any;
  description: string;
}

// Only surface parameters whose types can be trivially edited in the UI
const SIMPLE_TYPES = new Set(['number', 'string', 'boolean', 'string[]']);

function defaultForType(typeStr: string): any {
  if (typeStr === 'number') return 0;
  if (typeStr === 'string') return '';
  if (typeStr === 'boolean') return false;
  if (typeStr === 'string[]') return [];
  return null;
}

// Walk up directory tree looking for node_modules/ai/dist/index.d.ts,
// starting from both the user's rootDir and process.cwd() (the evalution app).
function findAiDtsPath(rootDir: string): string | null {
  const seen = new Set<string>();
  for (const start of [rootDir, process.cwd()]) {
    let dir = start;
    while (!seen.has(dir)) {
      seen.add(dir);
      const candidate = path.join(dir, 'node_modules', 'ai', 'dist', 'index.d.ts');
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function extractJsDoc(fullText: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges?.length) return '';
  const last = ranges[ranges.length - 1];
  const raw = fullText.slice(last.pos, last.end);
  return raw
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .replace(/\n(?!\s*\n)/, '')
    .trim();
}

export function getCallSettings(rootDir: string): CallSettingInfo[] {
  const dtsPath = findAiDtsPath(rootDir);
  if (!dtsPath) return [];

  const sourceText = fs.readFileSync(dtsPath, 'utf-8');
  const sourceFile = ts.createSourceFile(dtsPath, sourceText, ts.ScriptTarget.Latest, true);

  const results: CallSettingInfo[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'CallSettings') {
      const typeNode = node.type;
      if (ts.isTypeLiteralNode(typeNode)) {
        for (const member of typeNode.members) {
          if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
            const typeStr = member.type?.getText(sourceFile).trim() ?? 'unknown';
            if (SIMPLE_TYPES.has(typeStr)) {
              results.push({
                name: member.name.text,
                type: typeStr,
                defaultValue: defaultForType(typeStr),
                description: extractJsDoc(sourceText, member),
              });
            }
          }
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return results;
}
