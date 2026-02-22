import { useState } from 'react';
import type { ParsedPrompt } from '../../shared/types';
import { encodePromptId } from '../utils';

interface Props {
  prompt: ParsedPrompt;
}

function PlaygroundExecution({ prompt }: Props) {
  const [paramValues, setParamValues] = useState<Record<string, any>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleParamChange = (name: string, value: string) => {
    setParamValues(prev => ({ ...prev, [name]: value }));
  };

  const validate = (): boolean => {
    for (const param of prompt.functionParameters) {
      if (param.defaultValue === undefined && !paramValues[param.name]) {
        setError(`Parameter '${param.name}' is required`);
        return false;
      }
    }
    return true;
  };

  const handleExecute = async (stream: boolean) => {
    if (!validate()) return;
    setExecuting(true);
    setError(null);
    setResult('');
    try {
      if (stream) await executeStream();
      else await executeGenerate();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
    }
  };

  const executeGenerate = async () => {
    const res = await fetch(`/api/prompts/${encodePromptId(prompt.id)}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: false, functionParams: paramValues }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Execution failed');
    const data = await res.json();
    setResult(data.text);
  };

  const executeStream = async () => {
    const res = await fetch(`/api/prompts/${encodePromptId(prompt.id)}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, functionParams: paramValues }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Execution failed');

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (data.chunk) setResult(prev => prev + data.chunk);
        }
      }
    }
  };

  return (
    <div className="pg-exec">
      <div className="pg-panel">
        <div className="pg-panel-header">
          <span className="pg-panel-title">Execute</span>
        </div>
        {prompt.functionParameters.length > 0 && (
          <div className="pg-panel-body">
            {prompt.functionParameters.map(param => (
              <div key={param.name} className="pg-panel-card pg-param-card">
                <div className="pg-param-label">
                  {param.name}
                  {param.type && <span className="pg-param-type"> : {param.type}</span>}
                </div>
                <input
                  className="pg-param-input"
                  type="text"
                  value={paramValues[param.name] ?? ''}
                  onChange={e => handleParamChange(param.name, e.target.value)}
                  placeholder={param.defaultValue !== undefined ? `Default: ${param.defaultValue}` : 'Required'}
                />
              </div>
            ))}
          </div>
        )}
        <div className="pg-panel-footer">
          <button
            className="pg-pill-btn pg-pill-primary"
            onClick={() => handleExecute(false)}
            disabled={executing}
          >
            {executing ? '…' : '▶  Run'}
          </button>
          <button
            className="pg-pill-btn"
            onClick={() => handleExecute(true)}
            disabled={executing}
          >
            Stream
          </button>
        </div>
      </div>

      {error && (
        <div className="pg-panel pg-panel-error">
          <div className="pg-panel-header">
            <span className="pg-panel-title pg-panel-title-error">Error</span>
          </div>
          <div className="pg-panel-body">
            <div className="pg-output-body">{error}</div>
          </div>
        </div>
      )}

      {(result || (executing && !result)) && (
        <div className="pg-panel">
          <div className="pg-panel-header">
            <span className="pg-panel-title">Output</span>
          </div>
          <div className="pg-panel-body">
            <div className="pg-output-body">
              {executing && !result
                ? <span className="pg-spinner">Running…</span>
                : <pre>{result}</pre>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PlaygroundExecution;
