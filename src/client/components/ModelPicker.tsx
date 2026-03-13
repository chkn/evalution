import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ModelCatalog, ModelValueType } from '../../shared/types';
import ProviderIcon from './ProviderIcon';

interface Props {
  value: any;
  onChange: (v: any) => void;
  modelCatalog: ModelCatalog;
}

function ChevronDown({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, pointerEvents: 'none', color: '#9ca3af' }}>
      <path d="M2.5 4.5L6 8L9.5 4.5" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, color: '#111827' }}>
      <path d="M2.5 7.5L5.5 10.5L11.5 4" />
    </svg>
  );
}

/** Parse the incoming model value (string or ModelValue object) into provider + model + mode. */
function parseValue(value: any): { provider: string; model: string; mode: ModelValueType } {
  if (typeof value === 'object' && value?.type === 'function') {
    return { provider: value.provider ?? 'openai', model: value.model ?? '', mode: 'function' };
  }
  if (typeof value === 'object' && value?.type === 'string') {
    const m = value.model ?? '';
    const idx = m.indexOf('/');
    if (idx >= 0) return { provider: m.slice(0, idx), model: m.slice(idx + 1), mode: 'string' };
    return { provider: '', model: m, mode: 'string' };
  }
  if (typeof value === 'string') {
    const idx = value.indexOf('/');
    if (idx >= 0) return { provider: value.slice(0, idx), model: value.slice(idx + 1), mode: 'string' };
    return { provider: '', model: value, mode: 'string' };
  }
  return { provider: 'openai', model: 'gpt-4o', mode: 'function' };
}

/** Build a source-code representation string for display. */
function sourceRepr(provider: string, model: string, mode: ModelValueType): string {
  if (mode === 'function') {
    return `${provider}('${model}')`;
  }
  return provider ? `${provider}/${model}` : model;
}

export default function ModelPicker({ value, onChange, modelCatalog }: Props) {
  const [open, setOpen] = useState(false);
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [gatewayInput, setGatewayInput] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const { provider, model, mode } = parseValue(value);
  const modes = modelCatalog.modes ?? [{ key: 'string' as const, label: '' }];
  const activeMode = mode;

  // Look up pretty label
  const displayLabel = modelCatalog.providers[provider]?.models
    .find(m => m.id === model)?.label ?? model;

  // Position the dropdown portal beneath the trigger
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    });
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  const emitValue = (p: string, m: string, modeKey: ModelValueType, close: boolean = true) => {
    if (modeKey === 'function') {
      onChange({ type: 'function', provider: p, model: m });
    } else {
      onChange({ type: 'string', model: p ? `${p}/${m}` : m });
    }
    if (close) setOpen(false);
  };

  const switchMode = (newMode: ModelValueType) => {
    if (newMode === activeMode) return;
    emitValue(provider, model, newMode, false);
  };

  const handleCustomSubmit = (providerKey: string) => {
    const val = (customInputs[providerKey] ?? '').trim();
    if (!val) return;
    emitValue(providerKey, val, activeMode);
    setCustomInputs(prev => ({ ...prev, [providerKey]: '' }));
  };

  const handleGatewaySubmit = () => {
    const val = gatewayInput.trim();
    if (!val) return;
    onChange({ type: 'string', model: val });
    setGatewayInput('');
    setOpen(false);
  };

  const providerEntries = Object.entries(modelCatalog.providers);

  const dropdown = open && createPortal(
    <div className="pg-model-picker-dropdown" ref={dropdownRef} style={dropdownStyle}>
      {/* Mode toggle */}
      {modes.length > 1 && (
        <div className="pg-mode-toggle">
          {modes.map(m => (
            <button
              key={m.key}
              type="button"
              className={'pg-mode-btn' + (activeMode === m.key ? ' active' : '')}
              onClick={() => switchMode(m.key)}
              title={m.description}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {/* Provider groups */}
      {providerEntries.map(([providerKey, info]) => {
        const isCurrentProvider = provider === providerKey;
        return (
          <div key={providerKey} className="pg-provider-group">
            <div className="pg-provider-group-header">
              <ProviderIcon provider={providerKey} size={16} />
              <span>{info.name}</span>
            </div>
            {info.models.map(mi => {
              const isSelected = isCurrentProvider && mi.id === model;
              return (
                <button
                  key={mi.id}
                  type="button"
                  className={'pg-model-option' + (isSelected ? ' selected' : '')}
                  onClick={() => emitValue(providerKey, mi.id, activeMode)}
                >
                  <span className="pg-model-option-check">
                    {isSelected && <CheckIcon size={13} />}
                  </span>
                  <span className="pg-model-option-label">{mi.label}</span>
                  <span className="pg-model-option-source">
                    {sourceRepr(providerKey, mi.id, activeMode)}
                  </span>
                </button>
              );
            })}
            {/* Custom model ID input */}
            <div className="pg-custom-model-row">
              <input
                type="text"
                placeholder="Custom model ID…"
                value={customInputs[providerKey] ?? ''}
                onChange={e => setCustomInputs(prev => ({ ...prev, [providerKey]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') handleCustomSubmit(providerKey); }}
              />
              <button
                type="button"
                className="pg-custom-model-use"
                onClick={() => handleCustomSubmit(providerKey)}
              >
                Use
              </button>
            </div>
          </div>
        );
      })}

      {/* Custom gateway input (only in string/gateway mode) */}
      {activeMode === 'string' && (
        <div className="pg-custom-gateway-row">
          <input
            type="text"
            placeholder="Custom model string…"
            value={gatewayInput}
            onChange={e => setGatewayInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleGatewaySubmit(); }}
          />
          <button
            type="button"
            className="pg-custom-model-use"
            onClick={handleGatewaySubmit}
          >
            Use
          </button>
        </div>
      )}
    </div>,
    document.body,
  );

  return (
    <div className="pg-panel-card pg-model-picker">
      <button
        ref={triggerRef}
        className="pg-model-picker-trigger"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ProviderIcon provider={provider} size={20} />
        <span className="pg-model-picker-label">{displayLabel}</span>
        <span className="pg-model-picker-source">{sourceRepr(provider, model, activeMode)}</span>
        <ChevronDown size={14} />
      </button>
      {dropdown}
    </div>
  );
}
