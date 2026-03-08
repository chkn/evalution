import { useState, useEffect, useRef } from 'react';
import type { ModelInfo, ParsedPrompt, PromptProperty, ModelParameterInfo, ModelCatalog } from '../../shared/types';
import { getModelCatalog, getModelParameters, updatePromptProperties  } from '../api';
import TokenEditor from './TokenEditor';

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

function hasParameterTokens(value: any): boolean {
  if (typeof value === 'string') return /\$\{[^}]+\}/.test(value);
  if (Array.isArray(value)) return value.some(hasParameterTokens);
  if (value && typeof value === 'object') return Object.values(value).some(hasParameterTokens);
  return false;
}

function applyPromptUpdate(prompt: ParsedPrompt, key: string, value: any): ParsedPrompt {
  const nextProperties = { ...prompt.properties };

  if (value === null) {
    delete nextProperties[key];
  } else {
    const existing = nextProperties[key];
    nextProperties[key] = existing
      ? { ...existing, value, hasParameterTokens: hasParameterTokens(value) }
      : {
          name: key,
          value,
          isEditable: true,
          hasParameterTokens: hasParameterTokens(value),
        };
  }

  return {
    ...prompt,
    properties: nextProperties,
  };
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

// ─── ModelCard ────────────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97706',
  google: '#4285f4',
};

function ModelCard({ value, onChange, modelCatalog }: { value: any; onChange: (v: any) => void; modelCatalog: ModelCatalog }) {
  let provider = 'openai';
  let model = 'gpt-4o';
  if (typeof value === 'object' && value?.type === 'function') {
    provider = value.provider ?? 'openai';
    model = value.model ?? 'gpt-4o';
  } else if (typeof value === 'string') {
    const idx = value.indexOf('/');
    if (idx >= 0) { provider = value.slice(0, idx); model = value.slice(idx + 1); }
    else { model = value; }
  }
  const currentKey = `${provider}/${model}`;
  const displayLabel = modelCatalog.providers[provider]?.models
    .find(m => m.id === model)?.label ?? model;

  const handleChange = (key: string) => {
    if (typeof value === 'string') onChange(key);
    const [provider, model] = key.split('/');
    onChange({ type: 'function', provider, model });
  };

  const modelCatalogProviders = Object.entries(modelCatalog.providers);
  return (
    <div className="pg-panel-card pg-model-card">
      <span className="pg-provider-dot" style={{ background: PROVIDER_COLORS[provider] ?? '#888' }} />
      <span className="pg-model-name">{displayLabel}</span>
      <ChevronDown size={14} />
      <select
        className="pg-model-overlay-select"
        value={currentKey}
        onChange={e => handleChange(e.target.value)}
      >
        {modelCatalogProviders.map(([provider, info]) => (
          info.models.map(modelInfo => (
            <option key={`${provider}/${modelInfo.id}`} value={`${provider}/${modelInfo.id}`}>
              {modelInfo.label}
            </option>
          ))
        ))}
        {!modelCatalogProviders.some(([provider, p]) => p.models.some(m => `${provider}/${m.id}` === currentKey)) && (
          <option value={currentKey}>{currentKey}</option>
        )}
      </select>
    </div>
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

function SystemCard({ content, isEditable, onChange }: {
  content: string;
  isEditable: boolean;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(content);
  useEffect(() => setLocal(content), [content]);

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header">
        <span className="pg-role-label">System message</span>
      </div>
      {isEditable
        ? <TokenEditor className="token-editor" value={local} onChange={v => { setLocal(v); onChange(v); }} placeholder="System prompt…" />
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
      <TokenEditor className="token-editor" value={content} onChange={v => { setContent(v); onChange({ ...msg, content: v }); }} placeholder="Message content…" />
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

function ParamCard({ name, prop, description, onDelete, onChange }: {
  name: string;
  prop: PromptProperty;
  description: string;
  onDelete: () => void;
  onChange: (v: any) => void;
}) {
  const isNumber = typeof prop.value === 'number';
  const [local, setLocal] = useState(String(prop.value ?? ''));
  const [descExpanded, setDescExpanded] = useState(false);
  useEffect(() => setLocal(String(prop.value ?? '')), [prop.value]);

  const commit = () => {
    if (isNumber) {
      const n = parseFloat(local);
      if (!isNaN(n)) onChange(n);
    } else {
      onChange(local);
    }
  };

  const paragraphs = description ? description.split('\n') : [];
  const hasMore = paragraphs.length > 1;

  return (
    <div className="pg-panel-card">
      <div className="pg-msg-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="pg-role-label">{name}</span>
          {paragraphs.length > 0 && (
            <div className="pg-param-description">
              {descExpanded ? description : paragraphs[0]}
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
        {prop.isEditable && (
          <button className="pg-delete-msg" onClick={onDelete} title="Remove parameter">×</button>
        )}
      </div>
      {prop.isEditable ? (
        <input
          className="pg-param-input pg-param-input-inline"
          type={isNumber ? 'number' : 'text'}
          step="any"
          value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <div className="pg-msg-content" style={{ fontSize: 13, color: '#9ca3af' }}>
          {prop.sourceText}
        </div>
      )}
    </div>
  );
}

// ─── PlaygroundEditor ─────────────────────────────────────────────────────────

const EMPTY_MODEL_CATALOG: ModelCatalog = { providers: {} };

function PlaygroundEditor({ prompt, onUpdate, onDirtyChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onDirtyChange(saving); }, [saving]);
  const [localMessages, setLocalMessages] = useState<Msg[]>(
    Array.isArray(prompt.properties.messages?.value) ? prompt.properties.messages.value : []
  );
  const [modelParameters, setModelParameters] = useState<ModelParameterInfo[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>(EMPTY_MODEL_CATALOG);

  useEffect(() => {
    if (prompt.providerId) {
      getModelParameters(prompt.providerId).then(setModelParameters).catch(() => {});
      getModelCatalog(prompt.providerId).then(setModelCatalog).catch(() => {});
    }
  }, [prompt.providerId]);

  useEffect(() => {
    setLocalMessages(
      Array.isArray(prompt.properties.messages?.value) ? prompt.properties.messages.value : []
    );
  }, [prompt.properties.messages?.value]);

  const handleUpdate = async (key: string, value: any) => {
    setSaving(true);
    setError(null);
    try {
      await updatePromptProperties(prompt, { [key]: value });
      onUpdate(applyPromptUpdate(prompt, key, value));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const msgSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessagesChange = (msgs: Msg[]) => {
    setLocalMessages(msgs);
    if (msgSaveTimer.current) clearTimeout(msgSaveTimer.current);
    msgSaveTimer.current = setTimeout(() => handleUpdate('messages', msgs), 600);
  };

  const handleAddMessage = () => {
    const newMsgs = [...localMessages, { role: 'user', content: '' }];
    setLocalMessages(newMsgs);
    handleUpdate('messages', newMsgs);
  };

  const { model, system, messages } = prompt.properties;
  const modelValue = model?.value ?? { type: 'function', provider: 'openai', model: 'gpt-4o' };
  const systemValue = system?.value ?? '';
  const systemEditable = system ? system.isEditable : true;
  const modelParamKeys = new Set(['model', 'system', 'messages']);
  const modelParams = Object.entries(prompt.properties)
    .filter(([k]) => !modelParamKeys.has(k));

  // CallSettings params not yet present in the prompt
  const addableParams = modelParameters.filter(
    cs => prompt.properties[cs.name] === undefined
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
          <ModelCard value={modelValue} onChange={v => handleUpdate('model', v)} modelCatalog={modelCatalog} />
          {modelParams.map(([key, prop]) => (
            <ParamCard
              key={key}
              name={key}
              prop={prop}
              description={modelParameters.find(cs => cs.name === key)?.description ?? ''}
              onDelete={() => handleUpdate(key, null)}
              onChange={v => handleUpdate(key, v)}
            />
          ))}
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
                  if (cs) handleUpdate(cs.name, cs.defaultValue);
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
            content={systemValue}
            isEditable={systemEditable}
            onChange={v => handleUpdate('system', v)}
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
