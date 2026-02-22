import { useState } from 'react';
import type { ParsedPrompt } from '../../shared/types';
import { encodePromptId } from '../utils';

interface ExecutionPanelProps {
  prompt: ParsedPrompt;
}

function ExecutionPanel({ prompt }: ExecutionPanelProps) {
  const [paramValues, setParamValues] = useState<Record<string, any>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleParamChange = (paramName: string, value: any) => {
    setParamValues(prev => ({ ...prev, [paramName]: value }));
  };

  const validateParams = (): boolean => {
    for (const param of prompt.functionParameters) {
      if (param.defaultValue === undefined && !paramValues[param.name]) {
        setError(`Parameter '${param.name}' is required`);
        return false;
      }
    }
    return true;
  };

  const handleExecute = async (stream: boolean) => {
    if (!validateParams()) {
      return;
    }

    setExecuting(true);
    setError(null);
    setResult('');

    try {
      if (stream) {
        await executeStream();
      } else {
        await executeGenerate();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const executeGenerate = async () => {
    const response = await fetch(`/api/prompts/${encodePromptId(prompt.id)}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: false,
        functionParams: paramValues,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Execution failed');
    }

    const data = await response.json();
    setResult(data.text);
  };

  const executeStream = async () => {
    const response = await fetch(`/api/prompts/${encodePromptId(prompt.id)}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stream: true,
        functionParams: paramValues,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Execution failed');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (data.chunk) {
            setResult(prev => prev + data.chunk);
          }
        }
      }
    }
  };

  return (
    <div className="execution-panel">
      <h3>Execute Prompt</h3>

      {prompt.functionParameters.length > 0 && (
        <div className="param-inputs">
          <h4>Parameters</h4>
          {prompt.functionParameters.map(param => (
            <div key={param.name} className="param-input">
              <label>
                {param.name}
                {param.type && <span className="param-type"> ({param.type})</span>}
                {param.defaultValue !== undefined && (
                  <span className="param-default"> = {JSON.stringify(param.defaultValue)}</span>
                )}
              </label>
              <input
                type="text"
                value={paramValues[param.name] || ''}
                onChange={(e) => handleParamChange(param.name, e.target.value)}
                placeholder={param.defaultValue !== undefined ? `Default: ${param.defaultValue}` : 'Required'}
              />
            </div>
          ))}
        </div>
      )}

      <div className="execution-controls">
        <button
          onClick={() => handleExecute(false)}
          disabled={executing}
          className="execute-button"
        >
          {executing ? 'Executing...' : 'Generate'}
        </button>
        <button
          onClick={() => handleExecute(true)}
          disabled={executing}
          className="execute-button stream"
        >
          {executing ? 'Streaming...' : 'Stream'}
        </button>
      </div>

      {error && (
        <div className="execution-error">
          Error: {error}
        </div>
      )}

      {result && (
        <div className="execution-result">
          <h4>Result</h4>
          <pre>{result}</pre>
        </div>
      )}

      {executing && !result && (
        <div className="execution-loading">
          <div className="spinner">Executing...</div>
        </div>
      )}
    </div>
  );
}

export default ExecutionPanel;
