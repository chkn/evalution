// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useCallback, useEffect, useRef, useState } from "react";
/*
function TracesIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="6" y1="18" x2="16" y2="18" />
    </svg>
  );
}

function NewVariantIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}
*/
import type {
  ExecuteResponse,
  ModelCatalog,
  NormalizedPrompt,
  NormalizedPromptUpdates,
} from "../../shared/types";
import { getModelCatalog, updatePromptProperties } from "../api";
import PlaygroundEditor from "./PlaygroundEditor";
import PlaygroundExecution from "./PlaygroundExecution";

interface Props {
  prompt: NormalizedPrompt;
  onUpdate: (updated: NormalizedPrompt) => void;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Invoked after a successful execution with the trace that was registered
   * for it. Lets the surrounding app open a trace tab in a split pane.
   */
  onExecuted?: (result: ExecuteResponse & { label: string }) => void;
}

const EMPTY_MODEL_CATALOG: ModelCatalog = { models: [] };

function stableKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
}

function promptKey(prompt: NormalizedPrompt): string {
  return stableKey(prompt);
}

function applyOptimisticUpdates(
  prompt: NormalizedPrompt,
  updates: NormalizedPromptUpdates,
): NormalizedPrompt {
  let next = prompt;

  if ("system" in updates) {
    next = { ...next };
    if (updates.system == null) {
      delete next.system;
    } else {
      next.system = updates.system;
    }
  }

  if ("messages" in updates) {
    next = { ...next, messages: updates.messages ?? [] };
  }

  return next;
}

function PlaygroundContent({
  prompt,
  onUpdate,
  onDirtyChange,
  onExecuted,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] =
    useState<ModelCatalog>(EMPTY_MODEL_CATALOG);
  const promptRef = useRef(prompt);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    onDirtyChange(saving);
  }, [saving, onDirtyChange]);

  useEffect(() => {
    if (prompt.providerId) {
      getModelCatalog(prompt.providerId)
        .then(setModelCatalog)
        .catch(() => {});
    }
  }, [prompt.providerId]);

  const handleUpdate = useCallback(
    async (updates: NormalizedPromptUpdates) => {
      const basePrompt = promptRef.current;
      const optimisticPrompt = applyOptimisticUpdates(basePrompt, updates);
      if (promptKey(optimisticPrompt) !== promptKey(basePrompt)) {
        promptRef.current = optimisticPrompt;
        onUpdate(optimisticPrompt);
      }

      setSaving(true);
      setError(null);
      try {
        const updatedPrompt = await updatePromptProperties(basePrompt, updates);
        if (promptKey(updatedPrompt) !== promptKey(promptRef.current)) {
          promptRef.current = updatedPrompt;
          onUpdate(updatedPrompt);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setSaving(false);
      }
    },
    [onUpdate],
  );

  return (
    <div className="pg-playground-wrapper">
      <div className="pg-prompt-header">
        <div className="pg-prompt-header-identity">
          <span className="pg-prompt-name">{prompt.name}</span>
          {prompt.treePath && prompt.treePath.length > 0 && (
            <span className="pg-prompt-path">{prompt.treePath.join("/")}</span>
          )}
        </div>
        <div className="pg-prompt-header-right">
          {error && (
            <div className="pg-header-error">
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
          {/*
          <button className="pg-header-btn pg-header-btn--icon" title="Show traces"><TracesIcon /></button>
          <button className="pg-header-btn pg-header-btn--icon" title="New variant"><NewVariantIcon /></button>
          */}
        </div>
      </div>
      <div className="pg-content">
        <div className="pg-editor-col">
          <PlaygroundEditor
            prompt={prompt}
            onUpdate={handleUpdate}
            modelCatalog={modelCatalog}
          />
        </div>
        <div className="pg-exec-col">
          <PlaygroundExecution prompt={prompt} onExecuted={onExecuted} />
        </div>
      </div>
    </div>
  );
}

export default PlaygroundContent;
