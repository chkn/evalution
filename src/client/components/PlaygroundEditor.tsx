import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import type { ParsedPrompt, PromptProperty } from '../../shared/types';
import { POPULAR_MODELS } from '../../shared/constants';

interface CallSettingInfo {
  name: string;
  type: string;
  defaultValue: any;
  description: string;
}

interface Props {
  prompt: ParsedPrompt;
  onUpdate: () => void;
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

function AutoResizeTextarea({ value, onChange, onBlur, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = ref.current.scrollHeight + 'px';
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={1}
    />
  );
}

// ─── ModelCard ────────────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97706',
  google: '#4285f4',
};

function ModelCard({ value, onChange }: { value: any; onChange: (v: any) => void }) {
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
  const displayLabel = POPULAR_MODELS
    .find(m => `${m.provider}/${m.model}` === currentKey)
    ?.label.replace(/ \(.*\)$/, '') ?? model;

  const handleChange = (key: string) => {
    const found = POPULAR_MODELS.find(m => `${m.provider}/${m.model}` === key);
    if (!found) return;
    if (typeof value === 'string') onChange(key);
    else onChange({ type: 'function', provider: found.provider, model: found.model });
  };

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
        {POPULAR_MODELS.map(m => (
          <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>
            {m.label}
          </option>
        ))}
        {!POPULAR_MODELS.some(m => `${m.provider}/${m.model}` === currentKey) && (
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
        ? <AutoResizeTextarea
            className="pg-msg-textarea"
            value={local}
            onChange={setLocal}
            onBlur={() => onChange(local)}
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
      <AutoResizeTextarea
        className="pg-msg-textarea"
        value={content}
        onChange={v => { setContent(v); onChange({ ...msg, content: v }); }}
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

function PlaygroundEditor({ prompt, onUpdate }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<Msg[]>(
    Array.isArray(prompt.properties.messages?.value) ? prompt.properties.messages.value : []
  );
  const [callSettings, setCallSettings] = useState<CallSettingInfo[]>([]);

  useEffect(() => {
    fetch('/api/call-settings')
      .then(r => r.json())
      .then(setCallSettings)
      .catch(() => {});
  }, []);

  const handleUpdate = async (key: string, value: any) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(prompt.id)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed');
      onUpdate();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleMessagesChange = (msgs: Msg[]) => {
    setLocalMessages(msgs);
    handleUpdate('messages', msgs);
  };

  const handleAddMessage = () => {
    const newMsgs = [...localMessages, { role: 'user', content: '' }];
    setLocalMessages(newMsgs);
    handleUpdate('messages', newMsgs);
  };

  const { model, system, messages } = prompt.properties;
  const modelParamKeys = new Set(['model', 'system', 'messages']);
  const modelParams = Object.entries(prompt.properties)
    .filter(([k]) => !modelParamKeys.has(k));

  // CallSettings params not yet present in the prompt
  const addableParams = callSettings.filter(
    cs => prompt.properties[cs.name] === undefined
  );

  return (
    <div className="pg-editor">
      {saving && <div className="pg-status-bar">Saving…</div>}
      {error && (
        <div className="pg-error-bar">
          {error}
          <button className="pg-dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {model && (
        <div className="pg-panel">
          <div className="pg-panel-header">
            <span className="pg-panel-title">Model</span>
          </div>
          <div className="pg-panel-body">
            <ModelCard value={model.value} onChange={v => handleUpdate('model', v)} />
            {modelParams.map(([key, prop]) => (
              <ParamCard
                key={key}
                name={key}
                prop={prop}
                description={callSettings.find(cs => cs.name === key)?.description ?? ''}
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
                    const cs = callSettings.find(p => p.name === e.target.value);
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
      )}

      {(system || messages) && (
        <div className="pg-panel">
          <div className="pg-panel-header">
            <span className="pg-panel-title">Messages</span>
          </div>
          <div className="pg-panel-body">
            {system && (
              <SystemCard
                content={system.value}
                isEditable={system.isEditable}
                onChange={v => handleUpdate('system', v)}
              />
            )}
            {messages && localMessages.map((msg, i) => (
              <MessageCard
                key={i}
                msg={msg}
                onChange={m => handleMessagesChange(localMessages.map((x, j) => j === i ? m : x))}
                onDelete={() => handleMessagesChange(localMessages.filter((_, j) => j !== i))}
              />
            ))}
          </div>
          {messages && (
            <div className="pg-panel-footer">
              <button className="pg-pill-btn" onClick={handleAddMessage}>＋ Message</button>
            </div>
          )}
        </div>
      )}

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
