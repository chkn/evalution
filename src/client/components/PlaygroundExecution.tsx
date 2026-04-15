import { useState } from 'react';
import type { NormalizedPrompt, PropValue } from '../../shared/types';
import { PropsEditor, materializeValue } from 'ts-proppy/react';
import { executePrompt, streamPrompt } from '../api';

interface Props {
  prompt: NormalizedPrompt;
}

function PlaygroundExecution({ prompt }: Props) {
  const [paramValues, setParamValues] = useState<Record<string, PropValue>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleParamChange = (name: string, value: PropValue) => {
    setParamValues(prev => ({ ...prev, [name]: value }));
  };

  const resolveParams = async (): Promise<any[] | null> => {
    const resolved: any[] = [];
    for (const param of prompt.functionParameters) {
      const current = paramValues[param.name] ?? param.defaultValue;
      if (current === undefined) {
        if (!param.optional) {
          setError(`Parameter '${param.name}' is required`);
          return null;
        }
        resolved.push(undefined);
      } else {
        resolved.push(await materializeValue(current));
      }
    }
    return resolved;
  };

  const handleExecute = async (stream: boolean) => {
    setError(null);
    setResult('');
    const resolved = await resolveParams();
    if (!resolved) return;
    setExecuting(true);
    try {
      if (stream) await executeStream(resolved);
      else await executeGenerate(resolved);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
    }
  };

  const executeGenerate = async (params: any[]) => {
    const data = await executePrompt(prompt, params);
    setResult(data.text);
  };

  const executeStream = async (params: any[]) => {
    for await (const chunk of streamPrompt(prompt, params)) {
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
            <PropsEditor
              props={{ definitions: prompt.functionParameters, values: paramValues }}
              onChange={handleParamChange}
            />
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
