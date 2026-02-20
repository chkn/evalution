import { useState } from 'react';
import type { PromptProperty } from '../../shared/types';

interface ParameterEditorProps {
  property: PromptProperty;
  onChange: (value: any) => void;
}

function ParameterEditor({ property, onChange }: ParameterEditorProps) {
  const [value, setValue] = useState(property.value);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const handleChange = (newValue: any) => {
    setValue(newValue);
  };

  const handleBlur = () => {
    onChange(value);
  };

  const handleJsonChange = (text: string) => {
    setValue(text);
    try {
      const parsed = JSON.parse(text);
      setJsonError(null);
      onChange(parsed);
    } catch (err: any) {
      setJsonError(err.message);
    }
  };

  if (!property.isEditable) {
    return (
      <div className="parameter-editor read-only">
        <label>{property.name}</label>
        <div className="read-only-label">Read-only (computed)</div>
        <pre className="value-display">{JSON.stringify(property.value, null, 2)}</pre>
      </div>
    );
  }

  const renderEditor = () => {
    const val = property.value;

    // String
    if (typeof val === 'string') {
      return (
        <textarea
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          rows={3}
          className={property.hasParameterTokens ? 'has-tokens' : ''}
        />
      );
    }

    // Number
    if (typeof val === 'number') {
      return (
        <input
          type="number"
          value={value}
          onChange={(e) => handleChange(parseFloat(e.target.value))}
          onBlur={handleBlur}
          step="0.1"
        />
      );
    }

    // Boolean
    if (typeof val === 'boolean') {
      return (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => {
              handleChange(e.target.checked);
              onChange(e.target.checked);
            }}
          />
          {value ? 'true' : 'false'}
        </label>
      );
    }

    // Array or Object
    if (typeof val === 'object') {
      const jsonString = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return (
        <div>
          <textarea
            value={jsonString}
            onChange={(e) => handleJsonChange(e.target.value)}
            rows={10}
            className="json-editor"
          />
          {jsonError && <div className="error-message">{jsonError}</div>}
        </div>
      );
    }

    return <div>Unsupported type</div>;
  };

  return (
    <div className="parameter-editor">
      <label>
        {property.name}
        {property.hasParameterTokens && (
          <span className="token-indicator"> (contains parameter tokens)</span>
        )}
      </label>
      {renderEditor()}
    </div>
  );
}

export default ParameterEditor;
