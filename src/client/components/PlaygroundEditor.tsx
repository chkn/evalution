import { useState, useEffect, useRef } from 'react';
import type {
  NormalizedPrompt,
  NormalizedMessage,
  NormalizedPromptUpdates,
  NormalizedParameter,
  PropDefinition,
  PropValue,
  ModelCatalog,
} from '../../shared/types';
import { getModelCatalog, getModelParameters, updatePromptProperties  } from '../api';
import { ItemEditor, TemplateEditor, valueToSourceText } from 'ts-proppy/react';
import { isEditable } from '../../shared/helpers';
import { defaultValueForType } from '../utils';
import ModelPicker from './ModelPicker';

interface Props {
  prompt: NormalizedPrompt;
  onUpdate: (updated: NormalizedPrompt) => void;
  onDirtyChange: (dirty: boolean) => void;
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

function SystemCard({ content, editable, onChange }: {
  content: string;
  editable: boolean;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(content);
  useEffect(() => setLocal(content), [content]);

  const handleChange = (v: PropValue) => {
    const str = propValueToString(v);
    setLocal(str);
    onChange(str);
  };

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header">
        <span className="pg-role-label">System message</span>
      </div>
      {editable
        ? <TemplateEditor
            propDef={TEMPLATE_PROP_DEF}
            value={{ kind: 'template', value: local }}
            onChange={handleChange}
            className="token-editor"
            placeholder="System prompt…"
          />
        : <div className="pg-msg-content">{content}</div>
      }
    </div>
  );
}

function MessageCard({ msg, onChange, onDelete }: {
  msg: NormalizedMessage;
  onChange: (m: NormalizedMessage) => void;
  onDelete: () => void;
}) {
  const [content, setContent] = useState(msg.content);
  useEffect(() => setContent(msg.content), [msg.content]);

  const handleChange = (v: PropValue) => {
    const str = propValueToString(v);
    setContent(str);
    onChange({ ...msg, content: str });
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
        propDef={TEMPLATE_PROP_DEF}
        value={{ kind: 'template', value: content }}
        onChange={handleChange}
        className="token-editor"
        placeholder="Message content…"
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

// ─── PlaygroundEditor ─────────────────────────────────────────────────────────

const EMPTY_MODEL_CATALOG: ModelCatalog = { models: [] };

function propValueToString(value: PropValue | undefined): string {
  if (!value) return '';
  if (value.kind === 'primitive' && typeof value.value === 'string') return value.value;
  if (value.kind === 'template') return value.value;
  if (value.kind === 'raw') return value.sourceText;
  return '';
}

function stringToSystemPropValue(v: string): PropValue {
  return v.includes('${')
    ? { kind: 'template', value: v }
    : { kind: 'primitive', value: v };
}

function PlaygroundEditor({ prompt, onUpdate, onDirtyChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onDirtyChange(saving); }, [saving]);
  const [localMessages, setLocalMessages] = useState<NormalizedMessage[]>(prompt.messages);
  const [modelParameters, setModelParameters] = useState<PropDefinition[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);

  useEffect(() => {
    if (prompt.providerId) {
      getModelParameters(prompt.providerId).then(setModelParameters).catch(() => {});
      getModelCatalog(prompt.providerId).then(setModelCatalog).catch(() => {});
    }
  }, [prompt.providerId]);

  useEffect(() => {
    setLocalMessages(prompt.messages);
  }, [prompt.messages]);

  const handleUpdate = async (updates: NormalizedPromptUpdates) => {
    setSaving(true);
    setError(null);
    try {
      onUpdate(await updatePromptProperties(prompt, updates));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const msgSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessagesChange = (msgs: NormalizedMessage[]) => {
    setLocalMessages(msgs);
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current);
    msgSaveTimer.current = setTimeout(() => handleUpdate({ messages: msgs }), 600);
  };

  const handleSystemChange = (v: string) => {
    if (systemSaveTimer.current) clearTimeout(systemSaveTimer.current);
    systemSaveTimer.current = setTimeout(() => {
      handleUpdate({ system: stringToSystemPropValue(v) });
    }, 600);
  };

  const handleAddMessage = () => {
    const newMsgs: NormalizedMessage[] = [...localMessages, { role: 'user', content: '' }];
    setLocalMessages(newMsgs);
    handleUpdate({ messages: newMsgs });
  };

  const systemStr = propValueToString(prompt.system);
  const existingParams = new Set(prompt.modelParameters.map(p => p.def.name));
  const addableParams = modelParameters.filter(cs => !existingParams.has(cs.name));

  return (
    <div className="pg-editor">
      {error && (
        <div className="pg-error-bar">
          {error}
          <button className="pg-dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="pg-panel">
        <div className="pg-panel-header">
          <span className="pg-panel-title">Model</span>
        </div>
        <div className="pg-panel-body">
          <ModelPicker value={prompt.model} onChange={v => handleUpdate({ model: v })} modelCatalog={modelCatalog} />
          {prompt.modelParameters.map((param: NormalizedParameter) => {
            const propDef = modelParameters.find(cs => cs.name === param.def.name);
            if (!propDef) {
              // No PropDefinition available — show source text as read-only
              return (
                <div key={param.def.name} className="pg-panel-card">
                  <div className="pg-msg-header">
                    <span className="pg-role-label">{param.def.name}</span>
                    {param.value && isEditable(param.value) && (
                      <button
                        className="pg-delete-msg"
                        onClick={() => handleUpdate({ modelParameters: { [param.def.name]: null } })}
                        title="Remove parameter"
                      >×</button>
                    )}
                  </div>
                  <div className="pg-msg-content" style={{ fontSize: 13, color: '#9ca3af' }}>
                    {param.value ? valueToSourceText(param.value) : ''}
                  </div>
                </div>
              );
            }
            return (
              <ParamCard
                key={param.def.name}
                propDef={propDef}
                value={param.value}
                onDelete={() => handleUpdate({ modelParameters: { [param.def.name]: null } })}
                onChange={v => handleUpdate({ modelParameters: { [param.def.name]: v } })}
              />
            );
          })}
        </div>
        {addableParams.length > 0 && (
          <div className="pg-panel-footer">
            <div className="pg-pill-btn pg-add-param-btn">
              ＋ Parameter
              <select
                className="pg-model-overlay-select"
                value=""
                onChange={e => {
                  if (!e.target.value) return;
                  const cs = modelParameters.find(p => p.name === e.target.value);
                  if (!cs) return;
                  handleUpdate({ modelParameters: { [cs.name]: cs.defaultValue ?? defaultValueForType(cs.type) } });
                }}
              >
                <option value="">Add parameter…</option>
                {addableParams.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="pg-panel">
        <div className="pg-panel-header">
          <span className="pg-panel-title">Messages</span>
        </div>
        <div className="pg-panel-body">
          <SystemCard
            content={systemStr}
            editable={prompt.systemEditable}
            onChange={handleSystemChange}
          />
          {localMessages.map((msg, i) => (
            <MessageCard
              key={i}
              msg={msg}
              onChange={m => handleMessagesChange(localMessages.map((x, j) => j === i ? m : x))}
              onDelete={() => handleMessagesChange(localMessages.filter((_, j) => j !== i))}
            />
          ))}
        </div>
        <div className="pg-panel-footer">
          <button className="pg-pill-btn" onClick={handleAddMessage}>＋ Message</button>
        </div>
      </div>

      <div className="pg-panel">
        <div className="pg-panel-header">
          <span className="pg-panel-title">Tools</span>
        </div>
        <div className="pg-panel-footer">
          <button className="pg-pill-btn" disabled>＋ Tool</button>
          <button className="pg-pill-btn">Output type: Text ▾</button>
        </div>
      </div>
    </div>
  );
}

export default PlaygroundEditor;
