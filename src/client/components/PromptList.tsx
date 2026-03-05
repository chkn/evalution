import { useState, useMemo } from 'react';
import type { ParsedPrompt } from '../../shared/types';

interface PromptListProps {
  prompts: ParsedPrompt[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  onAddPrompt?: () => void;
}

// --- Tree building ---

interface RawTree {
  subdirs: Record<string, RawTree>;
  files: Record<string, ParsedPrompt[]>;
}

type CompressedNode =
  | { type: 'dir'; label: string; children: CompressedNode[] }
  | { type: 'file'; label: string; prompts: ParsedPrompt[] };

function buildRawTree(prompts: ParsedPrompt[]): RawTree {
  const root: RawTree = { subdirs: {}, files: {} };

  for (const prompt of prompts) {
    const segments = prompt.treePath;

    if (!segments || segments.length === 0) {
      const leafLabel = prompt.name;
      if (!root.files[leafLabel]) root.files[leafLabel] = [];
      root.files[leafLabel].push(prompt);
      continue;
    }

    const leafLabel = segments[segments.length - 1];
    const dirParts = segments.slice(0, -1);

    let node = root;
    for (const dir of dirParts) {
      if (!node.subdirs[dir]) {
        node.subdirs[dir] = { subdirs: {}, files: {} };
      }
      node = node.subdirs[dir];
    }

    if (!node.files[leafLabel]) {
      node.files[leafLabel] = [];
    }
    node.files[leafLabel].push(prompt);
  }

  return root;
}

function compressTree(tree: RawTree): CompressedNode[] {
  const nodes: CompressedNode[] = [];

  const sortedDirs = Object.keys(tree.subdirs).sort();
  const sortedFiles = Object.keys(tree.files).sort();

  for (const dirName of sortedDirs) {
    let label = dirName;
    let current = tree.subdirs[dirName];

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

function filterNodes(nodes: CompressedNode[], query: string): CompressedNode[] {
  const q = query.toLowerCase();
  const result: CompressedNode[] = [];

  for (const node of nodes) {
    if (node.type === 'dir') {
      const filteredChildren = filterNodes(node.children, query);
      if (filteredChildren.length > 0 || node.label.toLowerCase().includes(q)) {
        result.push({ ...node, children: filteredChildren.length > 0 ? filteredChildren : node.children });
      }
    } else {
      const matchesFile = node.label.toLowerCase().includes(q);
      const matchingPrompts = node.prompts.filter(p => p.name.toLowerCase().includes(q));
      if (matchesFile) {
        result.push(node);
      } else if (matchingPrompts.length > 0) {
        result.push({ ...node, prompts: matchingPrompts });
      }
    }
  }

  return result;
}

// --- Icons ---

function DisclosureTriangle({ expanded }: { expanded: boolean }) {
  return (
    <svg className="tree-disclosure" width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
      {expanded
        ? <path d="M1 2h6L4 6.5z"/>
        : <path d="M2 1v6L6.5 4z"/>
      }
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0014.5 4H8L6.5 2.5h-5z"/>
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg className="tree-icon" width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
      <path d="M1.5 1A1.5 1.5 0 000 2.5v9A1.5 1.5 0 001.5 13h9a1.5 1.5 0 001.5-1.5v-7l-4-4h-7z"/>
      <path d="M8 0v3.5A1.5 1.5 0 009.5 5H12" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.3"/>
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 3h9M3 6h6M4.5 9h3"/>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <line x1="5.5" y1="1.5" x2="5.5" y2="9.5"/>
      <line x1="1.5" y1="5.5" x2="9.5" y2="5.5"/>
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
  const hasManyPrompts = node.prompts.length > 1;
  const indent = depth * 18;

  if (!hasManyPrompts) {
    // Single prompt — render directly as a leaf row
    const prompt = node.prompts[0];
    const isSelected = prompt.id === selectedId;
    return (
      <div
        className={`tree-row${isSelected ? ' tree-row-selected' : ''}`}
        style={{ paddingLeft: 10 + indent + 16 }}
        onClick={() => onSelect(prompt.id)}
      >
        <span className="tree-icon-prompt"><PromptIcon /></span>
        <span className="tree-row-label">{prompt.name}</span>
        {prompt.functionParameters.length > 0 && (
          <span className="tree-row-params">
            ({prompt.functionParameters.map(p => p.name).join(', ')})
          </span>
        )}
      </div>
    );
  }

  return (
    <div>
      <div
        className="tree-row"
        style={{ paddingLeft: 10 + indent }}
        onClick={() => setExpanded(e => !e)}
      >
        <DisclosureTriangle expanded={expanded} />
        <span className="tree-icon-file"><PromptIcon /></span>
        <span className="tree-row-label">{node.label}</span>
      </div>
      {expanded && node.prompts.map(prompt => {
        const isSelected = prompt.id === selectedId;
        return (
          <div
            key={prompt.id}
            className={`tree-row${isSelected ? ' tree-row-selected' : ''}`}
            style={{ paddingLeft: 10 + indent + 18 + 16 }}
            onClick={() => onSelect(prompt.id)}
          >
            <span className="tree-icon-prompt"><PromptIcon /></span>
            <span className="tree-row-label">{prompt.name}</span>
            {prompt.functionParameters.length > 0 && (
              <span className="tree-row-params">
                ({prompt.functionParameters.map(p => p.name).join(', ')})
              </span>
            )}
          </div>
        );
      })}
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
  const indent = depth * 18;

  return (
    <div>
      <div
        className="tree-row"
        style={{ paddingLeft: 10 + indent }}
        onClick={() => setExpanded(e => !e)}
      >
        <DisclosureTriangle expanded={expanded} />
        <span className="tree-icon-folder"><FolderIcon /></span>
        <span className="tree-row-label">{node.label}</span>
      </div>
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

function PromptList({ prompts, selectedId, onSelect, loading, error, onAddPrompt }: PromptListProps) {
  const [filter, setFilter] = useState('');

  const nodes = useMemo(() => {
    const rawTree = buildRawTree(prompts);
    const all = compressTree(rawTree);
    return filter ? filterNodes(all, filter) : all;
  }, [prompts, filter]);

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
      <>
        <div className="section-panel-body">
          <div className="tree-empty-state">
            <p>No prompts found.</p>
            {onAddPrompt && (
              <button className="tree-add-prompt-btn" onClick={onAddPrompt}>
                Create a prompt
              </button>
            )}
          </div>
        </div>
        <div className="tree-toolbar">
          {onAddPrompt && (
            <button className="tree-toolbar-btn" onClick={onAddPrompt} title="New prompt">
              <PlusIcon />
            </button>
          )}
          <div className="tree-filter">
            <FilterIcon />
            <input
              type="text"
              placeholder="Filter"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>
        </div>
      </>
    );
  }

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
      <div className="tree-toolbar">
        {onAddPrompt && (
          <button className="tree-toolbar-btn" onClick={onAddPrompt} title="New prompt">
            <PlusIcon />
          </button>
        )}
        <div className="tree-filter">
          <FilterIcon />
          <input
            type="text"
            placeholder="Filter"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
      </div>
    </>
  );
}

export default PromptList;
