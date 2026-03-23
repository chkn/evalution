import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ModelCatalog, ModelInfo, PromptProperty, PropValue } from '../../shared/types';
import { valueToSourceText } from 'ts-proppy';
import ProviderIcon from './ProviderIcon';

interface Props {
  property: PromptProperty;
  onChange: (v: PropValue) => void;
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

/** Compare two PropValues by their serialized source text */
function propValueEquals(a: unknown, b: PropValue): boolean {
  if (!a || typeof a !== 'object' || !('kind' in a)) return false;
  return valueToSourceText(a as PropValue) === valueToSourceText(b);
}

/** Deep-clone a PropValue template, replacing `$input` in primitive strings with `input`. */
function applyTemplate(template: PropValue, input: string): PropValue {
  switch (template.kind) {
    case 'primitive':
      if (typeof template.value === 'string') {
        return { kind: 'primitive', value: template.value.replace('$input', input) };
      }
      return template;
    case 'functionCall':
      return {
        ...template,
        args: template.args.map(a => applyTemplate(a, input)),
      };
    case 'object':
      return {
        kind: 'object',
        properties: Object.fromEntries(
          Object.entries(template.properties).map(([k, v]) => [k, applyTemplate(v, input)])
        ),
      };
    case 'array':
    case 'tuple':
      return { kind: template.kind, elements: template.elements.map(e => applyTemplate(e, input)) };
    default:
      return template;
  }
}

export default function ModelPicker({ property, onChange, modelCatalog }: Props) {
  const [open, setOpen] = useState(false);
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [gatewayInput, setGatewayInput] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const { modes, modelsByGroup, selectedModel, activeMode } = useMemo(() => {
    const modes = Object.entries(modelCatalog.modelValueTypes ?? {});

    let selectedModel: (ModelInfo & { mode: string }) | undefined;
    const modelsByGroup: Record<string, ModelInfo[]> = {};

    for (const model of modelCatalog.models) {
      for (const [mode, value] of Object.entries(model.values)) {
        if (!selectedModel && propValueEquals(property.value, value)) {
          selectedModel = { ...model, mode };
        }
      }
      const group = model.group ?? '';
      (modelsByGroup[group] ??= []).push(model);
    }

    selectedModel ??= modelCatalog.models[0] ? { ...modelCatalog.models[0], mode: modes[0]?.[0] ?? '' } : undefined;
    const activeMode = selectedModel?.mode ?? modes[0]?.[0] ?? '';

    return { modes, modelsByGroup, selectedModel, activeMode };
  }, [modelCatalog, property.value]);

  const displayLabel = selectedModel?.label ?? '';

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

  const emitValue = (value: PropValue, close: boolean = true) => {
    onChange(value);
    if (close) setOpen(false);
  };

  const switchMode = (newMode: string) => {
    if (newMode === activeMode || !selectedModel) return;
    emitValue(selectedModel.values[newMode], false);
  };

  const handleCustomSubmit = (providerKey: string) => {
    const val = (customInputs[providerKey] ?? '').trim();
    if (!val) return;
    const template = modelCatalog.groups?.[providerKey]?.customValueTemplates?.[activeMode];
    if (!template) return;
    emitValue(applyTemplate(template, val));
    setCustomInputs(prev => ({ ...prev, [providerKey]: '' }));
  };

  const handleGatewaySubmit = () => {
    const val = gatewayInput.trim();
    if (!val) return;
    emitValue({ kind: 'primitive', value: val });
    setGatewayInput('');
  };

  const dropdown = open && createPortal(
    <div className="pg-model-picker-dropdown" ref={dropdownRef} style={dropdownStyle}>
      {modes.length > 1 && (
        <div className="pg-mode-toggle">
          {modes.map(([mode, info]) => (
            <button
              key={mode}
              type="button"
              className={'pg-mode-btn' + (activeMode === mode ? ' active' : '')}
              onClick={() => switchMode(mode)}
              title={info.description}
            >
              {info.label}
            </button>
          ))}
        </div>
      )}

      {Object.entries(modelsByGroup).map(([providerKey, models]) => {
        const hasCustom = !!modelCatalog.groups?.[providerKey]?.customValueTemplates?.[activeMode];
        return (
          <div key={providerKey} className="pg-provider-group">
            <div className="pg-provider-group-header">
              <ProviderIcon provider={providerKey} size={16} />
              <span>{providerKey}</span>
            </div>
            {models.map(mi => {
              const isSelected = mi.id === selectedModel?.id;
              const modelValue = mi.values[activeMode];
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
            {hasCustom && (
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
            )}
          </div>
        );
      })}

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
        <ProviderIcon provider={selectedModel?.group} size={20} />
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
