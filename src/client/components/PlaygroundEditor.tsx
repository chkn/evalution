import { useState, useEffect, useRef } from 'react';
import type { ParsedPrompt, PropDefinition, PropValue, ModelCatalog } from '../../shared/types';
import { getModelCatalog, getModelParameters, updatePromptProperties  } from '../api';
import { ItemEditor, TemplateEditor } from 'ts-proppy/react';
import { valueToSourceText } from 'ts-proppy';
import { isEditable } from '../../shared/is-editable';
import ModelPicker from './ModelPicker';

interface Props {
  prompt: ParsedPrompt;
  onUpdate: (updated: ParsedPrompt) => void;
  onDirtyChange: (dirty: boolean) => void;
}

interface ToolCallEntry {
  toolName: string;
  args: string;
}

interface Msg {
  role: string;
  content: string;
  toolCalls?: ToolCallEntry[];
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
  toolCalls: ToolCallEntry[];
  onChange: (tc: ToolCallEntry[]) => void;
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
    const str = v.kind === 'template' ? v.value : v.kind === 'primitive' && typeof v.value === 'string' ? v.value : '';
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
  msg: Msg;
  onChange: (m: Msg) => void;
  onDelete: () => void;
}) {
  const [content, setContent] = useState(msg.content);
  useEffect(() => setContent(msg.content), [msg.content]);

  const handleChange = (v: PropValue) => {
    const str = v.kind === 'template' ? v.value : v.kind === 'primitive' && typeof v.value === 'string' ? v.value : '';
    setContent(str);
    onChange({ ...msg, content: str });
  };

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header">
        <div className="pg-role-wrapper">
          <select
            className="pg-role-select"
            value={msg.role}
            onChange={e => onChange({ ...msg, role: e.target.value })}
          >
            {Object.entries(ROLE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
          <ChevronDown size={10} />
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
      <ItemEditor propDef={propDef} value={value} onChange={onChange} />
    </div>
  );
}

// ─── PlaygroundEditor ─────────────────────────────────────────────────────────

const EMPTY_MODEL_CATALOG: ModelCatalog = { models: [] };

function PlaygroundEditor({ prompt, onUpdate, onDirtyChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onDirtyChange(saving); }, [saving]);
  const [localMessages, setLocalMessages] = useState<Msg[]>(
    extractMessages(prompt)
  );
  const [modelParameters, setModelParameters] = useState<PropDefinition[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);

  useEffect(() => {
    if (prompt.providerId) {
      getModelParameters(prompt.providerId).then(setModelParameters).catch(() => {});
      getModelCatalog(prompt.providerId).then(setModelCatalog).catch(() => {});
    }
  }, [prompt.providerId]);

  useEffect(() => {
    setLocalMessages(extractMessages(prompt));
  }, [prompt.extractedProps.values?.messages]);

  const handleUpdate = async (key: string, value: any) => {
    setSaving(true);
    setError(null);
    try {
      onUpdate(await updatePromptProperties(prompt, { [key]: value }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const msgSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessagesChange = (msgs: Msg[]) => {
    setLocalMessages(msgs);
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current);
    msgSaveTimer.current = setTimeout(() => handleUpdate('messages', msgsToValue(msgs)), 600);
  };

  const handleSystemChange = (v: string) => {
    if (systemSaveTimer.current) clearTimeout(systemSaveTimer.current);
    systemSaveTimer.current = setTimeout(() => {
      const hasInterpolation = v.includes('${');
      const value: PropValue = hasInterpolation
        ? { kind: 'template', value: v }
        : { kind: 'primitive', value: v };
      handleUpdate('system', value);
    }, 600);
  };

  const handleAddMessage = () => {
    const newMsgs = [...localMessages, { role: 'user', content: '' }];
    setLocalMessages(newMsgs);
    handleUpdate('messages', msgsToValue(newMsgs));
  };

  const { definitions, values } = prompt.extractedProps;
  const modelValue = values?.model;
  const systemValue = values?.system;
  const systemStr = systemValue?.kind === 'primitive' && typeof systemValue.value === 'string'
    ? systemValue.value
    : systemValue?.kind === 'template' ? systemValue.value : '';
  const systemEditable = systemValue ? isEditable(systemValue) : true;
  const modelParamKeys = new Set(['model', 'system', 'messages']);
  const modelParams = definitions
    .filter(d => !modelParamKeys.has(d.name))
    .map(d => ({ def: d, value: values?.[d.name] }));

  // CallSettings params not yet present in the prompt
  const existingNames = new Set(definitions.map(d => d.name));
  const addableParams = modelParameters.filter(
    cs => !existingNames.has(cs.name)
  );

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
          <ModelPicker value={modelValue} onChange={v => handleUpdate('model', v)} modelCatalog={modelCatalog} />
          {modelParams.map(({ def, value: propValue }) => {
            const propDef = modelParameters.find(cs => cs.name === def.name);
            if (!propDef) {
              // No PropDefinition available — show source text as read-only
              return (
                <div key={def.name} className="pg-panel-card">
                  <div className="pg-msg-header">
                    <span className="pg-role-label">{def.name}</span>
                    {propValue && isEditable(propValue) && (
                      <button className="pg-delete-msg" onClick={() => handleUpdate(def.name, null)} title="Remove parameter">×</button>
                    )}
                  </div>
                  <div className="pg-msg-content" style={{ fontSize: 13, color: '#9ca3af' }}>
                    {propValue ? valueToSourceText(propValue) : ''}
                  </div>
                </div>
              );
            }
            return (
              <ParamCard
                key={def.name}
                propDef={propDef}
                value={propValue}
                onDelete={() => handleUpdate(def.name, null)}
                onChange={v => handleUpdate(def.name, v)}
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
                  if (cs?.defaultValue) handleUpdate(cs.name, cs.defaultValue);
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
            editable={systemEditable}
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

/** Convert a Msg[] back to a PropValue array for saving. */
function msgsToValue(msgs: Msg[]): PropValue {
  return {
    kind: 'array',
    elements: msgs.map(msg => {
      const contentHasInterpolation = msg.content.includes('${');
      const content: PropValue = contentHasInterpolation
        ? { kind: 'template', value: msg.content }
        : { kind: 'primitive', value: msg.content };
      return {
        kind: 'object',
        properties: {
          role: { kind: 'primitive', value: msg.role },
          content,
        },
      };
    }),
  };
}

/** Extract a plain Msg[] from the prompt's messages PropValue. */
function extractMessages(prompt: ParsedPrompt): Msg[] {
  const msgValue = prompt.extractedProps.values?.messages;
  if (!msgValue || msgValue.kind !== 'array') return [];
  return msgValue.elements.map(el => {
    if (el.kind !== 'object') return { role: 'user', content: '' };
    const role = el.properties.role?.kind === 'primitive' ? String(el.properties.role.value) : 'user';
    const content = el.properties.content?.kind === 'primitive' ? String(el.properties.content.value)
      : el.properties.content?.kind === 'template' ? el.properties.content.value : '';
    return { role, content };
  });
}

export default PlaygroundEditor;
