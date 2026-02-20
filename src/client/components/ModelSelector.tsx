import { useState } from 'react';
import { KNOWN_PROVIDERS, POPULAR_MODELS } from '../../shared/constants';

interface ModelSelectorProps {
  value: any;
  onChange: (value: any) => void;
}

type SelectionMode = 'popular' | 'provider' | 'custom';

function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [mode, setMode] = useState<SelectionMode>('popular');
  const [format, setFormat] = useState<'string' | 'function'>('function');
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [modelName, setModelName] = useState('gpt-4o');
  const [customString, setCustomString] = useState('');

  // Parse current value
  const currentModel = typeof value === 'string'
    ? value
    : typeof value === 'object' && value.type === 'function'
    ? `${value.provider}/${value.model}`
    : '';

  const handlePopularChange = (popularModel: string) => {
    const selected = POPULAR_MODELS.find(m => `${m.provider}/${m.model}` === popularModel);
    if (!selected) return;

    if (format === 'string') {
      onChange(`${selected.provider}/${selected.model}`);
    } else {
      onChange({
        type: 'function',
        provider: selected.provider,
        model: selected.model,
      });
    }
  };

  const handleProviderChange = () => {
    if (format === 'string') {
      onChange(`${selectedProvider}/${modelName}`);
    } else {
      onChange({
        type: 'function',
        provider: selectedProvider,
        model: modelName,
      });
    }
  };

  const handleCustomChange = () => {
    onChange(customString);
  };

  return (
    <div className="model-selector">
      <div className="mode-tabs">
        <button
          className={mode === 'popular' ? 'active' : ''}
          onClick={() => setMode('popular')}
        >
          Popular Models
        </button>
        <button
          className={mode === 'provider' ? 'active' : ''}
          onClick={() => setMode('provider')}
        >
          Provider + Model
        </button>
        <button
          className={mode === 'custom' ? 'active' : ''}
          onClick={() => setMode('custom')}
        >
          Custom String
        </button>
      </div>

      <div className="current-value">
        <strong>Current:</strong> <code>{currentModel}</code>
      </div>

      {mode === 'popular' && (
        <div className="selection-content">
          <label>
            Select Model:
            <select
              value={currentModel}
              onChange={(e) => handlePopularChange(e.target.value)}
            >
              <option value="">-- Select a model --</option>
              {POPULAR_MODELS.map(m => (
                <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="format-toggle">
            Format:
            <select value={format} onChange={(e) => setFormat(e.target.value as 'string' | 'function')}>
              <option value="function">Function Call (openai('gpt-4o'))</option>
              <option value="string">String ('openai/gpt-4o')</option>
            </select>
          </label>
        </div>
      )}

      {mode === 'provider' && (
        <div className="selection-content">
          <label>
            Provider:
            <select value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)}>
              {Object.entries(KNOWN_PROVIDERS).map(([key, info]) => (
                <option key={key} value={key}>{info.name}</option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>

          <label>
            Model Name:
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="gpt-4o"
            />
          </label>

          <label className="format-toggle">
            Format:
            <select value={format} onChange={(e) => setFormat(e.target.value as 'string' | 'function')}>
              <option value="function">Function Call</option>
              <option value="string">String</option>
            </select>
          </label>

          <button onClick={handleProviderChange}>Update Model</button>
        </div>
      )}

      {mode === 'custom' && (
        <div className="selection-content">
          <label>
            Custom Model String:
            <input
              type="text"
              value={customString}
              onChange={(e) => setCustomString(e.target.value)}
              placeholder="provider/model-name"
            />
          </label>

          <button onClick={handleCustomChange}>Update Model</button>
        </div>
      )}
    </div>
  );
}

export default ModelSelector;
