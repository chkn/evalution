// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type { FocusEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ItemEditor,
  interpolatablesFromDefinitions,
  recordFactories,
  recordKeyError,
  valueToDisplayString,
} from "ts-proppy/react";
import { canEdit } from "../../shared/helpers";
import type {
  NormalizedQuestionsPrompt,
  PropDefinition,
  PropValue,
  QuestionsPromptUpdates,
} from "../../shared/types";
import { useSyncedExternal } from "../hooks/useSyncedExternal";
import ModelRow from "./ModelRow";
import { questionPlugins } from "./question-plugins";
import {
  addQuestion,
  questionDefinition,
  questionEntries,
  renameQuestion,
} from "./questions";

/** Updates a {@link QuestionsPromptEditor} emits; the caller supplies the style. */
export type QuestionsEditorUpdates = Omit<QuestionsPromptUpdates, "style">;

interface Props {
  prompt: NormalizedQuestionsPrompt;
  onUpdate: (updates: QuestionsEditorUpdates) => void;
  /** The SDK's model slot, or `null` while it loads. */
  modelDefinition: PropDefinition | null;
}

const SAVE_DELAY_MS = 600;

/** A value that isn't editable, shown as its source. */
function ReadOnlyValue({ value }: { value: PropValue | undefined }) {
  return (
    <div className="pg-msg-content" data-readonly="true">
      {value === undefined ? "" : valueToDisplayString(value)}
    </div>
  );
}

/**
 * A question's id, edited as a draft and committed on blur or Enter. Keeps
 * focus through the rename: cards are keyed by position, not by id.
 */
function QuestionId({
  id,
  questions,
  disabled,
  onRename,
}: {
  id: string;
  questions: Record<string, PropValue>;
  disabled: boolean;
  onRename: (next: string) => void;
}) {
  const [draft, setDraft] = useState(id);
  useEffect(() => setDraft(id), [id]);
  const error = recordKeyError(questions, id, draft);
  const commit = () => {
    if (error) setDraft(id);
    else if (draft !== id) onRename(draft);
  };
  return (
    <input
      className="pg-question-id"
      aria-label="Question id"
      aria-invalid={!!error}
      title={error ?? "Identifies this question's answer"}
      value={draft}
      readOnly={disabled}
      spellCheck={false}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(id);
        }
      }}
    />
  );
}

/**
 * The editor for a {@link NormalizedQuestionsPrompt}: the model, the state the
 * questions are asked about, and the questions themselves — one card per
 * question, each edited through the SDK's own question types.
 *
 * Everything below the layout is ts-proppy's: a question built by a factory
 * (`choice(…)`) is edited argument by argument, an object-form question
 * through the SDK's question union, and `${…}` completion works at any depth.
 */
export default function QuestionsPromptEditor({
  prompt,
  onUpdate,
  modelDefinition,
}: Props) {
  const syncPausedRef = useRef(false);
  const [syncVersion, setSyncVersion] = useState(0);
  const [state, setState] = useSyncedExternal(
    prompt.state.value,
    syncVersion,
    syncPausedRef,
  );
  const [questionsValue, setQuestionsValue] = useSyncedExternal(
    prompt.questions.value,
    syncVersion,
    syncPausedRef,
  );
  const plugins = useMemo(questionPlugins, []);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);

  const interpolatables = useMemo(
    () => interpolatablesFromDefinitions(prompt.functionParameters),
    [prompt.functionParameters],
  );

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const save = (key: "state" | "questions", value: PropValue) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(
      () => onUpdate({ [key]: value }),
      SAVE_DELAY_MS,
    );
  };

  const handleFocus = () => {
    syncPausedRef.current = true;
  };
  const handleBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      syncPausedRef.current = false;
      setSyncVersion(v => v + 1);
    }
  };

  const stateDef = useMemo(
    () => ({ ...prompt.state.def, interpolatables }),
    [prompt.state.def, interpolatables],
  );
  const questionDef = useMemo(() => {
    const def = questionDefinition(prompt.questions.def);
    return def && { ...def, interpolatables };
  }, [prompt.questions.def, interpolatables]);

  const questions = questionEntries(questionsValue);
  const questionsEditable = canEdit(prompt.questionsEditable, questionsValue);
  const factories = questionDef ? recordFactories(questionDef) : [];

  const setQuestions = (next: Record<string, PropValue>, immediate = false) => {
    const value: PropValue = { kind: "object", properties: next };
    setQuestionsValue(value);
    if (immediate) {
      clearTimeout(timers.current.questions);
      onUpdate({ questions: value });
    } else {
      save("questions", value);
    }
  };

  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-question-index="${index}"] [contenteditable="true"], [data-question-index="${index}"] textarea, [data-question-index="${index}"] input:not(.pg-question-id)`,
      )
      ?.focus();
  });

  return (
    <div className="pg-editor pg-questions-editor">
      <div className="pg-panel">
        <div className="pg-panel-model-row">
          <ModelRow
            definition={modelDefinition}
            value={prompt.model}
            editable={canEdit(prompt.modelEditable, prompt.model)}
            onChange={v => onUpdate({ model: v })}
          />
        </div>
      </div>

      <div className="pg-panel" onFocus={handleFocus} onBlur={handleBlur}>
        <div className="pg-panel-card pg-state-card">
          <div className="pg-msg-header">
            <span className="pg-role-label">State</span>
            <span className="pg-card-hint" title="What the questions are about">
              ?
            </span>
          </div>
          {canEdit(prompt.stateEditable, state) ? (
            <ItemEditor
              propDef={stateDef}
              value={state}
              onChange={v => {
                setState(v);
                save("state", v);
              }}
              plugins={plugins}
              path={["state"]}
            />
          ) : (
            <ReadOnlyValue value={state} />
          )}
        </div>

        <div className="pg-msg-header">
          <span className="pg-role-label">Questions</span>
        </div>

        <div className="pg-questions" ref={listRef}>
          {questionsEditable && questionDef && questions ? (
            Object.entries(questions).map(([id, value], index) => (
              <div
                key={index}
                className="pg-panel-card pg-question-card"
                data-question-index={index}
              >
                <div className="pg-msg-header">
                  <QuestionId
                    id={id}
                    questions={questions}
                    disabled={false}
                    onRename={next =>
                      setQuestions(renameQuestion(questions, id, next), true)
                    }
                  />
                  <button
                    type="button"
                    className="pg-delete-msg"
                    title="Delete question"
                    onClick={() => {
                      const next = { ...questions };
                      delete next[id];
                      setQuestions(next, true);
                    }}
                  >
                    ×
                  </button>
                </div>
                <ItemEditor
                  propDef={{ ...questionDef, name: id }}
                  value={value}
                  onChange={v => setQuestions({ ...questions, [id]: v })}
                  plugins={plugins}
                  path={["questions", id]}
                />
              </div>
            ))
          ) : (
            <div className="pg-panel-card">
              <ReadOnlyValue value={questionsValue} />
            </div>
          )}
        </div>

        {questionsEditable &&
          questionDef &&
          questions &&
          factories.length > 0 && (
            <div className="pg-panel-footer">
              <div className="pg-add-msg-btn pg-add-question">
                ＋ Add question
                <select
                  aria-label="Add question"
                  className="pg-model-overlay-select"
                  value=""
                  onChange={e => {
                    const factory = factories.find(
                      f => f.factory.def.name === e.target.value,
                    )?.factory;
                    if (!factory) return;
                    const added = addQuestion(questions, factory);
                    pendingFocus.current =
                      Object.keys(added.questions).length - 1;
                    setQuestions(added.questions, true);
                  }}
                >
                  <option value="">Choose…</option>
                  {factories.map(({ label, factory }) => (
                    <option key={factory.def.name} value={factory.def.name}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
