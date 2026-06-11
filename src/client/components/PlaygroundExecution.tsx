// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { materializeValue, PropsEditor } from "ts-proppy/react";
import type {
  ExecuteResponse,
  NormalizedPrompt,
  PropValue,
} from "../../shared/types";
import { executePrompt } from "../api";

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

  const paramCount = prompt.functionParameters.length;

  return (
    <div className="pg-exec-inner">
      <div className="pg-exec-header">
        <span className="pg-exec-title">Execute</span>
        {paramCount > 0 && (
          <span className="pg-exec-param-count">
            {paramCount} param{paramCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div className="pg-exec-body">
        {paramCount > 0 && (
          <PropsEditor
            props={{
              definitions: prompt.functionParameters,
              values: paramValues,
            }}
            onChange={handleParamChange}
          />
        )}
        {error && (
          <div className="pg-exec-error">
            {error}
            <button
              type="button"
              className="pg-dismiss"
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
      <div className="pg-exec-footer">
        <button
          type="button"
          className="pg-run-btn"
          onClick={handleRun}
          disabled={executing}
        >
          {executing ? "…" : "▶  Run"}
        </button>
      </div>
    </div>
  );
}

export default PlaygroundExecution;
