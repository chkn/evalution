import { useState } from 'react';
import type { ParsedPrompt } from '../../shared/types';

interface PromptListProps {
  prompts: ParsedPrompt[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  rootPath: string;
}

// --- Tree building ---

interface RawTree {
  subdirs: Record<string, RawTree>;
  files: Record<string, ParsedPrompt[]>;
}

type CompressedNode =
  | { type: 'dir'; label: string; children: CompressedNode[] }
  | { type: 'file'; label: string; prompts: ParsedPrompt[] };

function buildRawTree(prompts: ParsedPrompt[], rootPath: string): RawTree {
  const root: RawTree = { subdirs: {}, files: {} };

  for (const prompt of prompts) {
    const filePath = (prompt.metadata?.filePath as string) ?? prompt.id;
    let relPath = filePath;
    if (rootPath && filePath.startsWith(rootPath)) {
      relPath = filePath.slice(rootPath.length).replace(/^\//, '');
    }

    const parts = relPath.split('/');
    const fileName = parts[parts.length - 1].split('#')[0]; // Remove function name suffix if present
    const dirParts = parts.slice(0, -1);

    let node = root;
    for (const dir of dirParts) {
      if (!node.subdirs[dir]) {
        node.subdirs[dir] = { subdirs: {}, files: {} };
      }
      node = node.subdirs[dir];
    }

    if (!node.files[fileName]) {
      node.files[fileName] = [];
    }
    node.files[fileName].push(prompt);
  }

  return root;
}

function compressTree(tree: RawTree): CompressedNode[] {
  const nodes: CompressedNode[] = [];

  // Directories first (sorted), then files (sorted)
  const sortedDirs = Object.keys(tree.subdirs).sort();
  const sortedFiles = Object.keys(tree.files).sort();

  for (const dirName of sortedDirs) {
    let label = dirName;
    let current = tree.subdirs[dirName];

    // Compress single-child dir chains (no files at intermediate levels)
    while (
      Object.keys(current.subdirs).length === 1 &&
      Object.keys(current.files).length === 0
    ) {
      const [childName, childTree] = Object.entries(current.subdirs)[0];
      label += '/' + childName;
      current = childTree;
    }

    nodes.push({ type: 'dir', label, children: compressTree(current) });
  }

  for (const fileName of sortedFiles) {
    nodes.push({ type: 'file', label: fileName, prompts: tree.files[fileName] });
  }

  return nodes;
}

// --- Icons ---

function ChevronRight() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 2L7 5L3.5 8"/>
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5L5 7L8 3.5"/>
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0014.5 4H8L6.5 2.5h-5z"/>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M1 1.5A1.5 1.5 0 012.5 0h4.586a1.5 1.5 0 011.06.44l2.415 2.414A1.5 1.5 0 0111 3.914V11.5A1.5 1.5 0 019.5 13h-7A1.5 1.5 0 011 11.5v-10z"/>
    </svg>
  );
}

// --- Tree node components ---

function FileNode({
  node,
  selectedId,
  onSelect,
  depth,
}: {
  node: CompressedNode & { type: 'file' };
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const indent = depth * 12;

  return (
    <div>
      <button
        className="tree-file-label"
        style={{ paddingLeft: 8 + indent }}
        onClick={() => setExpanded(e => !e)}
      >
        <span className="tree-chevron">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="tree-file-icon"><FileIcon /></span>
        <span className="tree-label-text">{node.label}</span>
      </button>
      {expanded && node.prompts.map(prompt => (
        <button
          key={prompt.id}
          className={`tree-prompt-btn${prompt.id === selectedId ? ' selected' : ''}`}
          style={{ paddingLeft: 20 + indent }}
          onClick={() => onSelect(prompt.id)}
        >
          {prompt.name}
          {prompt.functionParameters.length > 0 && (
            <span className="tree-prompt-params">
              ({prompt.functionParameters.map(p => p.name).join(', ')})
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function DirNode({
  node,
  selectedId,
  onSelect,
  depth,
}: {
  node: CompressedNode & { type: 'dir' };
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const indent = depth * 12;

  return (
    <div>
      <button
        className="tree-dir-label"
        style={{ paddingLeft: 8 + indent }}
        onClick={() => setExpanded(e => !e)}
      >
        <span className="tree-chevron">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="tree-folder-icon"><FolderIcon /></span>
        <span className="tree-label-text">{node.label}</span>
      </button>
      {expanded && (
        <div>
          {node.children.map((child, i) =>
            child.type === 'dir' ? (
              <DirNode key={i} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
            ) : (
              <FileNode key={i} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
            )
          )}
        </div>
      )}
    </div>
  );
}

// --- Main component ---

function PromptList({ prompts, selectedId, onSelect, loading, error, rootPath }: PromptListProps) {
  if (loading) {
    return (
      <div className="section-panel-body">
        <div className="tree-status">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="section-panel-body">
        <div className="tree-status tree-error">Error: {error}</div>
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div className="section-panel-body">
        <div className="tree-status">No .prompt.ts files found.</div>
      </div>
    );
  }

  const rawTree = buildRawTree(prompts, rootPath);
  const nodes = compressTree(rawTree);

  return (
    <>
      <div className="section-panel-body file-tree">
        {nodes.map((node, i) =>
          node.type === 'dir' ? (
            <DirNode key={i} node={node} selectedId={selectedId} onSelect={onSelect} depth={0} />
          ) : (
            <FileNode key={i} node={node} selectedId={selectedId} onSelect={onSelect} depth={0} />
          )
        )}
      </div>
    </>
  );
}

export default PromptList;
