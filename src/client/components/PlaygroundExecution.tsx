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

// `globalId` survives file moves/renames, so it's the more stable key when
// present; `id` (always present) is the fallback.
function paramStorageKey(prompt: NormalizedPrompt): string {
  return `pg-exec-params:${prompt.globalId ?? prompt.id}`;
}

function loadStoredParamValues(
  prompt: NormalizedPrompt,
): Record<string, PropValue> {
  try {
    const stored = localStorage.getItem(paramStorageKey(prompt));
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* ignore (private browsing, quota, corrupt entry, etc.) */
  }
  return {};
}

function PlaygroundExecution({ prompt, onExecuted }: Props) {
  const [paramValues, setParamValues] = useState<Record<string, PropValue>>(
    () => loadStoredParamValues(prompt),
  );
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleParamChange = (name: string, value: PropValue) => {
    setParamValues(prev => {
      const next = { ...prev, [name]: value };
      try {
        localStorage.setItem(paramStorageKey(prompt), JSON.stringify(next));
      } catch {
        /* ignore (private browsing, quota, etc.) */
      }
      return next;
    });
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
        try {
          resolved.push(await materializeValue(current));
        } catch (e: any) {
          setError(
            `Parameter '${param.name}' could not be resolved: ${e.message}`,
          );
          return null;
        }
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
