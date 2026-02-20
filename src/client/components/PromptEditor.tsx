import { useState } from 'react';
import type { ParsedPrompt } from '../../shared/types';
import ModelSelector from './ModelSelector';
import MessageBuilder from './MessageBuilder';
import ParameterEditor from './ParameterEditor';

interface PromptEditorProps {
  prompt: ParsedPrompt;
  onUpdate: () => void;
}

function PromptEditor({ prompt, onUpdate }: PromptEditorProps) {
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handlePropertyUpdate = async (propertyName: string, value: any) => {
    setUpdating(true);
    setUpdateStatus(null);

    try {
      const response = await fetch(`/api/prompts/${encodeURIComponent(prompt.id)}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ [propertyName]: value }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Update failed');
      }

      setUpdateStatus({ type: 'success', message: 'Updated successfully!' });
      setTimeout(() => setUpdateStatus(null), 3000);
      onUpdate();
    } catch (error: any) {
      setUpdateStatus({ type: 'error', message: error.message });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="prompt-editor">
      <div className="editor-header">
        <h2>{prompt.name}</h2>
        <div className="file-info">
          {prompt.metadata?.filePath?.split('/').pop()}
        </div>
      </div>

      {updateStatus && (
        <div className={`update-status ${updateStatus.type}`}>
          {updateStatus.message}
        </div>
      )}

      {prompt.functionParameters.length > 0 && (
        <div className="function-params-section">
          <h3>Function Parameters</h3>
          <div className="params-info">
            Parameter tokens like <code>${'{paramName}'}</code> are preserved in values below.
          </div>
          <table className="params-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Default Value</th>
              </tr>
            </thead>
            <tbody>
              {prompt.functionParameters.map(param => (
                <tr key={param.name}>
                  <td><code>{param.name}</code></td>
                  <td>{param.type || 'any'}</td>
                  <td>{param.defaultValue !== undefined ? JSON.stringify(param.defaultValue) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="properties-section">
        <h3>Prompt Configuration</h3>

        {Object.entries(prompt.properties).map(([key, property]) => {
          if (key === 'model') {
            return (
              <div key={key} className="property-item">
                <h4>Model</h4>
                <ModelSelector
                  value={property.value}
                  onChange={(value) => handlePropertyUpdate('model', value)}
                />
              </div>
            );
          }

          if (key === 'messages') {
            return (
              <div key={key} className="property-item">
                <MessageBuilder
                  messages={property.value}
                  isEditable={property.isEditable}
                  onChange={(value) => handlePropertyUpdate('messages', value)}
                />
              </div>
            );
          }

          return (
            <div key={key} className="property-item">
              <ParameterEditor
                property={property}
                onChange={(value) => handlePropertyUpdate(key, value)}
              />
            </div>
          );
        })}
      </div>

      {updating && (
        <div className="updating-overlay">
          <div className="spinner">Updating...</div>
        </div>
      )}
    </div>
  );
}

export default PromptEditor;
