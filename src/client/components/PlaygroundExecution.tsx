import { useState } from 'react';
import type { ExecuteResponse, NormalizedPrompt, PropValue } from '../../shared/types';
import { PropsEditor, materializeValue } from 'ts-proppy/react';
import { executePrompt } from '../api';

interface Props {
  prompt: NormalizedPrompt;
  /**
   * Invoked with the trace reference returned by the execute endpoint. Lets
   * the surrounding app open the corresponding trace tab.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
}

function PlaygroundExecution({ prompt, onExecuted }: Props) {
  const [paramValues, setParamValues] = useState<Record<string, PropValue>>({});
  const [executing, setExecuting] = useState(false);
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

  const handleRun = async () => {
    setError(null);
    const resolved = await resolveParams();
    if (!resolved) return;
    setExecuting(true);
    try {
      const result = await executePrompt(prompt, resolved);
      onExecuted?.({ ...result, label: prompt.name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setExecuting(false);
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
            onClick={handleRun}
            disabled={executing}
          >
            {executing ? '…' : '▶  Run'}
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
    </div>
  );
}

export default PlaygroundExecution;
