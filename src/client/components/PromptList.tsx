import { useState, useMemo, useRef, useEffect } from 'react';
import type { ParsedPrompt } from '../../shared/types';

interface PromptListProps {
  prompts: ParsedPrompt[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  onAddPrompt?: () => void;
  onRenamePrompt?: (promptId: string, newName: string) => void;
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
    <svg className="tree-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg className="tree-icon" width="12" height="12" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
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

// --- Inline rename input ---

function RenameInput({ initialValue, onCommit, onCancel }: {
  initialValue: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="tree-rename-input"
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); if (value.trim()) onCommit(value.trim()); else onCancel(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={() => { if (value.trim() && value.trim() !== initialValue) onCommit(value.trim()); else onCancel(); }}
      onClick={e => e.stopPropagation()}
    />
  );
}

// --- Tree node components ---

interface TreeNodeProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  renamingId: string | null;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, newName: string) => void;
  onCancelRename: () => void;
}

function PromptRow({ prompt, indent, selectedId, onSelect, renamingId, onStartRename, onCommitRename, onCancelRename }: {
  prompt: ParsedPrompt;
  indent: number;
} & TreeNodeProps) {
  const isSelected = prompt.id === selectedId;
  const isRenaming = prompt.id === renamingId;

  return (
    <div
      className={`tree-row${isSelected ? ' tree-row-selected' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => onSelect(prompt.id)}
      onDoubleClick={e => { e.stopPropagation(); onStartRename(prompt.id); }}
    >
      <span className="tree-icon-prompt"><PromptIcon /></span>
      {isRenaming ? (
        <RenameInput
          initialValue={prompt.name}
          onCommit={newName => onCommitRename(prompt.id, newName)}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          <span className="tree-row-label">{prompt.name}</span>
          {prompt.functionParameters.length > 0 && (
            <span className="tree-row-params">
              ({prompt.functionParameters.map(p => p.name).join(', ')})
            </span>
          )}
        </>
      )}
    </div>
  );
}

function FileNode({ node, depth, ...rest }: { node: CompressedNode & { type: 'file' }; depth: number } & TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasManyPrompts = node.prompts.length > 1;
  const indent = depth * 18;

  if (!hasManyPrompts) {
    return <PromptRow prompt={node.prompts[0]} indent={10 + indent + 14} {...rest} />;
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
      {expanded && node.prompts.map(prompt => (
        <PromptRow key={prompt.id} prompt={prompt} indent={10 + indent + 18 + 16} {...rest} />
      ))}
    </div>
  );
}

function DirNode({ node, depth, ...rest }: { node: CompressedNode & { type: 'dir' }; depth: number } & TreeNodeProps) {
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
              <DirNode key={i} node={child} depth={depth + 1} {...rest} />
            ) : (
              <FileNode key={i} node={child} depth={depth + 1} {...rest} />
            )
          )}
        </div>
      )}
    </div>
  );
}

// --- Main component ---

function PromptList({ prompts, selectedId, onSelect, loading, error, onAddPrompt, onRenamePrompt }: PromptListProps) {
  const [filter, setFilter] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const handleCommitRename = (promptId: string, newName: string) => {
    setRenamingId(null);
    onRenamePrompt?.(promptId, newName);
  };

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
            <DirNode key={i} node={node} depth={0}
              selectedId={selectedId} onSelect={onSelect}
              renamingId={renamingId} onStartRename={setRenamingId}
              onCommitRename={handleCommitRename} onCancelRename={() => setRenamingId(null)}
            />
          ) : (
            <FileNode key={i} node={node} depth={0}
              selectedId={selectedId} onSelect={onSelect}
              renamingId={renamingId} onStartRename={setRenamingId}
              onCommitRename={handleCommitRename} onCancelRename={() => setRenamingId(null)}
            />
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
