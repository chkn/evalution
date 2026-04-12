import { useState } from 'react';
import type { NormalizedPrompt } from '../../shared/types';
import { executePrompt, streamPrompt } from '../api';

interface Props {
  prompt: NormalizedPrompt;
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
    const data = await executePrompt(prompt, paramValues);
    setResult(data.text);
  };

  const executeStream = async () => {
    for await (const chunk of streamPrompt(prompt, paramValues)) {
      setResult(prev => prev + chunk);
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
