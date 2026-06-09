import { useState, useEffect, useRef, useMemo } from 'react';
import type {
  NormalizedPrompt,
  NormalizedMessage,
  NormalizedPromptUpdates,
  NormalizedParameter,
  PropDefinition,
  PropValue,
  ModelCatalog,
} from '../../shared/types';
import { getModelParameters } from '../api';
import ModelPicker from './ModelPicker';
import { ItemEditor, TemplateEditor, valueToDisplayString, interpolatablesFromDefinitions } from 'ts-proppy/react';
import { isEditable } from '../../shared/helpers';
import { defaultValueForType } from '../utils';

interface Props {
  prompt: NormalizedPrompt;
  onUpdate: (updates: NormalizedPromptUpdates) => void;
  modelCatalog: ModelCatalog;
}

/**
 * Mirrors an external value into local state so it can be edited freely,
 * resyncing only when the external value structurally changes (not on every
 * parent re-render). Without the structural compare, an in-flight edit can be
 * stomped when the parent re-renders with a fresh-but-equal object reference
 * after a debounced save round-trips.
 */
function useSyncedExternal<T>(external: T): [T, (v: T) => void] {
  const [local, setLocal] = useState(external);
  const lastExternalKey = useRef<string | null>(null);
  if (lastExternalKey.current === null) {
    lastExternalKey.current = JSON.stringify(external);
  }
  useEffect(() => {
    const key = JSON.stringify(external);
    if (key !== lastExternalKey.current) {
      lastExternalKey.current = key;
      setLocal(external);
    }
  }, [external]);
  return [local, setLocal];
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function ChevronDown({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, pointerEvents: 'none', color: '#9ca3af' }}>
      <path d="M2.5 4.5L6 8L9.5 4.5" />
    </svg>
  );
}

// ─── ToolCallsSection ─────────────────────────────────────────────────────────

function ToolCallsSection({ toolCalls, onChange }: {
  toolCalls: NonNullable<NormalizedMessage['toolCalls']>;
  onChange: (tc: NonNullable<NormalizedMessage['toolCalls']>) => void;
}) {
  return (
    <div className="pg-tool-calls">
      {toolCalls.map((tc, i) => (
        <div key={i} className="pg-tool-call">
          <div className="pg-tool-call-header">
            <span className="pg-tool-call-label">Tool call</span>
            <button
              className="pg-delete-msg"
              onClick={() => onChange(toolCalls.filter((_, j) => j !== i))}
              title="Remove tool call"
            >×</button>
          </div>
          <div className="pg-tool-call-fields">
            <input
              className="pg-tool-name-input"
              placeholder="function_name"
              value={tc.toolName}
              onChange={e => onChange(toolCalls.map((t, j) => j === i ? { ...t, toolName: e.target.value } : t))}
            />
            <input
              className="pg-tool-args-input"
              placeholder='{ "key": "value" }'
              value={tc.args}
              onChange={e => onChange(toolCalls.map((t, j) => j === i ? { ...t, args: e.target.value } : t))}
            />
          </div>
        </div>
      ))}
      <button
        className="pg-add-tool-call-btn"
        onClick={() => onChange([...toolCalls, { toolName: '', args: '' }])}
      >
        ＋ Tool Call
      </button>
    </div>
  );
}

// ─── Message cards ────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  system: 'System message',
  user: 'User',
  assistant: 'AI',
  tool: 'Tool Result',
};

/** Minimal PropDefinition for template editing */
const TEMPLATE_PROP_DEF: PropDefinition = {
  name: '_template',
  type: { kind: 'primitive', syntax: 'string' },
  optional: false,
};

function SystemCard({ content, editable, propDef, onChange }: {
  content: PropValue | undefined;
  editable: boolean;
  propDef: PropDefinition;
  onChange: (v: PropValue) => void;
}) {
  const [local, setLocal] = useSyncedExternal(content);

  const handleChange = (v: PropValue) => {
    setLocal(v);
    onChange(v);
  };

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header">
        <span className="pg-role-label">System message</span>
      </div>
      {editable
        ? <TemplateEditor
            propDef={propDef}
            value={local}
            onChange={handleChange}
            className="token-editor"
            placeholder="System message…"
          />
        : <div className={`pg-msg-content${content === undefined ? ' pg-placeholder' : ''}`}>
            {content !== undefined ? valueToDisplayString(content) : 'System message…'}
          </div>
      }
    </div>
  );
}

function MessageCard({ msg, propDef, onChange, onDelete }: {
  msg: NormalizedMessage;
  propDef: PropDefinition;
  onChange: (m: NormalizedMessage) => void;
  onDelete: () => void;
}) {
  const [content, setContent] = useSyncedExternal(msg.content);

  const handleChange = (v: PropValue) => {
    setContent(v);
    onChange({ ...msg, content: v });
  };

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header">
        <div className="pg-role-wrapper">
          <span className="pg-role-label">{ROLE_LABELS[msg.role] ?? msg.role}</span>
          <ChevronDown size={10} />
          <select
            className="pg-role-select"
            value={msg.role}
            onChange={e => onChange({ ...msg, role: e.target.value })}
          >
            {Object.entries(ROLE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        <button className="pg-delete-msg" onClick={onDelete} title="Delete">×</button>
      </div>
      <TemplateEditor
        propDef={propDef}
        value={content}
        onChange={handleChange}
        className="token-editor"
      />
      {msg.role === 'assistant' && (
        <ToolCallsSection
          toolCalls={msg.toolCalls ?? []}
          onChange={toolCalls => onChange({ ...msg, toolCalls })}
        />
      )}
    </div>
  );
}

// ─── ParamCard ────────────────────────────────────────────────────────────────

function ParamCard({ propDef, value, onDelete, onChange }: {
  propDef: PropDefinition;
  value: PropValue | undefined;
  onDelete: () => void;
  onChange: (v: PropValue) => void;
}) {
  const [descExpanded, setDescExpanded] = useState(false);
  const paragraphs = propDef.description ? propDef.description.split('\n') : [];
  const hasMore = paragraphs.length > 1;

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="pg-role-label">{propDef.name}</span>
          {paragraphs.length > 0 && (
            <div className="pg-param-description">
              {descExpanded ? propDef.description : paragraphs[0]}
              {hasMore && (
                <button
                  className="pg-desc-toggle"
                  onClick={() => setDescExpanded(e => !e)}
                >
                  {descExpanded ? 'less' : 'more'}
                </button>
              )}
            </div>
          )}
        </div>
        <button className="pg-delete-msg" onClick={onDelete} title="Remove parameter">×</button>
      </div>
      <div className="pg-param-input-inline">
        <ItemEditor propDef={propDef} value={value} onChange={onChange} className="pg-param-input" />
      </div>
    </div>
  );
}

// ─── SettingsModal ────────────────────────────────────────────────────────────

function SettingsModal({ prompt, modelParameters, addableParams, onUpdate, onClose }: {
  prompt: NormalizedPrompt;
  modelParameters: PropDefinition[];
  addableParams: PropDefinition[];
  onUpdate: (updates: NormalizedPromptUpdates) => void;
  onClose: () => void;
}) {
  return (
    <div className="pg-modal-backdrop" onClick={onClose}>
      <div className="pg-modal" onClick={e => e.stopPropagation()}>
        <div className="pg-modal-header">
          <span className="pg-modal-title">Model settings</span>
          <button className="pg-delete-msg" onClick={onClose} title="Close">×</button>
        </div>
        <div className="pg-modal-body">
          {prompt.modelParameters.length === 0 ? (
            <div className="pg-modal-empty">No settings configured.</div>
          ) : (
            prompt.modelParameters.map((param: NormalizedParameter) => {
              const propDef = modelParameters.find(cs => cs.name === param.def.name);
              if (!propDef) {
                return (
                  <div key={param.def.name} className="pg-panel-card">
                    <div className="pg-msg-header">
                      <span className="pg-role-label">{param.def.name}</span>
                      {param.value && isEditable(param.value) && (
                        <button
                          className="pg-delete-msg"
                          onClick={() => onUpdate({ modelParameters: { [param.def.name]: null } })}
                          title="Remove"
                        >×</button>
                      )}
                    </div>
                    <div className="pg-msg-content" style={{ fontSize: 13, color: '#9ca3af' }}>
                      {param.value !== undefined ? valueToDisplayString(param.value) : ''}
                    </div>
                  </div>
                );
              }
              return (
                <ParamCard
                  key={param.def.name}
                  propDef={propDef}
                  value={param.value}
                  onDelete={() => onUpdate({ modelParameters: { [param.def.name]: null } })}
                  onChange={v => onUpdate({ modelParameters: { [param.def.name]: v } })}
                />
              );
            })
          )}
        </div>
        {addableParams.length > 0 && (
          <div className="pg-modal-footer">
            <div className="pg-pill-btn pg-add-param-btn">
              + Add setting
              <select
                className="pg-model-overlay-select"
                value=""
                onChange={e => {
                  if (!e.target.value) return;
                  const cs = addableParams.find(p => p.name === e.target.value);
                  if (!cs) return;
                  onUpdate({ modelParameters: { [cs.name]: cs.defaultValue ?? defaultValueForType(cs.type) } });
                }}
              >
                <option value="">Choose…</option>
                {addableParams.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PlaygroundEditor ─────────────────────────────────────────────────────────

function PlaygroundEditor({ prompt, onUpdate, modelCatalog }: Props) {
  const [localMessages, setLocalMessages] = useSyncedExternal(prompt.messages);
  const [modelParameters, setModelParameters] = useState<PropDefinition[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (prompt.providerId) {
      getModelParameters(prompt.providerId).then(setModelParameters).catch(() => {});
    }
  }, [prompt.providerId]);

  const msgSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessagesChange = (msgs: NormalizedMessage[]) => {
    setLocalMessages(msgs);
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current);
    msgSaveTimer.current = setTimeout(() => onUpdate({ messages: msgs }), 600);
  };

  const handleSystemChange = (system: PropValue) => {
    if (systemSaveTimer.current) clearTimeout(systemSaveTimer.current);
    systemSaveTimer.current = setTimeout(() => onUpdate({ system }), 600);
  };

  const handleAddMessage = () => {
    const last = localMessages[localMessages.length - 1];
    let role = 'user';
    if (last?.role === 'user') role = 'assistant';
    else if (last?.role === 'assistant' && last.toolCalls?.length) role = 'tool';
    const newMsgs: NormalizedMessage[] = [...localMessages, { role, content: { kind: 'primitive', value: '' } }];
    setLocalMessages(newMsgs);
    onUpdate({ messages: newMsgs });
  };

  const existingParams = new Set(prompt.modelParameters.map(p => p.def.name));
  const addableParams = modelCatalog.models.length > 0
    ? modelParameters.filter(cs => !existingParams.has(cs.name))
    : [];

  // Identifiers available for `${…}` interpolation in the system/message editors.
  const contentPropDef = useMemo<PropDefinition>(() => ({
    ...TEMPLATE_PROP_DEF,
    interpolatables: interpolatablesFromDefinitions(prompt.functionParameters),
  }), [prompt.functionParameters]);

  return (
    <div className="pg-editor">
      {settingsOpen && (
        <SettingsModal
          prompt={prompt}
          modelParameters={modelParameters}
          addableParams={addableParams}
          onUpdate={onUpdate}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <div className="pg-panel">
        <div className="pg-panel-model-row">
          <ModelPicker
            value={prompt.model}
            onChange={v => onUpdate({ model: v })}
            modelCatalog={modelCatalog}
          />
          <div className="pg-panel-model-row-actions">
            <button className="pg-pill-btn" onClick={() => setSettingsOpen(true)}>Settings</button>
            <button className="pg-pill-btn" disabled>Tools</button>
            <button className="pg-pill-btn">Output type: Text ▾</button>
          </div>
        </div>
      </div>

      <div className="pg-panel">
        <div className="pg-panel-body">
          <SystemCard
            content={prompt.system}
            editable={prompt.systemEditable}
            propDef={contentPropDef}
            onChange={handleSystemChange}
          />
          {localMessages.map((msg, i) => (
            <MessageCard
              key={i}
              msg={msg}
              propDef={contentPropDef}
              onChange={m => handleMessagesChange(localMessages.map((x, j) => j === i ? m : x))}
              onDelete={() => handleMessagesChange(localMessages.filter((_, j) => j !== i))}
            />
          ))}
        </div>
        <div className="pg-panel-footer">
          <button className="pg-add-msg-btn" onClick={handleAddMessage}>＋  Add message</button>
        </div>
      </div>

    </div>
  );
}

export default PlaygroundEditor;
