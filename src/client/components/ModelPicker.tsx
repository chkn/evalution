import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ModelCatalog, ModelMode, ModelValue, PromptProperty } from '../../shared/types';
import ProviderIcon from './ProviderIcon';

interface Props {
  property: PromptProperty<ModelValue>;
  onChange: (v: ModelValue) => void;
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

export default function ModelPicker({ property, onChange, modelCatalog }: Props) {
  const [open, setOpen] = useState(false);
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [gatewayInput, setGatewayInput] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const { provider, model, type: activeMode } = property.value;
  const modes = modelCatalog.modes ?? [{ key: 'string' as const, label: '' }];

  // Look up pretty label
  const displayLabel = provider ? modelCatalog.providers[provider]?.models
    .find(m => m.id === model)?.label ?? model : model;

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

  const emitValue = (value: ModelValue, close: boolean = true) => {
    onChange(value);
    if (close) setOpen(false);
  };

  const switchMode = (newMode: string) => {
    if (newMode === activeMode) return;
    emitValue({ ...property.value, type: newMode }, false);
  };

  const handleCustomSubmit = (providerKey: string) => {
    const val = (customInputs[providerKey] ?? '').trim();
    if (!val) return;
    emitValue({ type: activeMode, provider: providerKey, model: val });
    setCustomInputs(prev => ({ ...prev, [providerKey]: '' }));
  };

  const handleGatewaySubmit = () => {
    const val = gatewayInput.trim();
    if (!val) return;
    emitValue({ type: 'string', model: val });
    setGatewayInput('');
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
              const modelValue: ModelValue = { type: activeMode, provider: providerKey, model: mi.id };
              return (
                <button
                  key={mi.id}
                  type="button"
                  className={'pg-model-option' + (isSelected ? ' selected' : '')}
                  onClick={() => emitValue(modelValue)}
                >
                  <span className="pg-model-option-check">
                    {isSelected && <CheckIcon size={13} />}
                  </span>
                  <span className="pg-model-option-label">{mi.label}</span>
                  <span className="pg-model-option-source">{mi.id}</span>
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
        {property.sourceText && (
          <span className="pg-model-picker-source">{property.sourceText}</span>
        )}
        <ChevronDown size={14} />
      </button>
      {dropdown}
    </div>
  );
}
