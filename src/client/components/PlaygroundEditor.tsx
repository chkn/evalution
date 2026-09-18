// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { memo, useCallback } from "react";
import type {
  NormalizedPrompt,
  NormalizedPromptUpdates,
  PropDefinition,
} from "../../shared/types";
import ChatPromptEditor, { type ChatEditorUpdates } from "./ChatPromptEditor";
import QuestionsPromptEditor, {
  type QuestionsEditorUpdates,
} from "./QuestionsPromptEditor";

interface Props {
  prompt: NormalizedPrompt;
  onUpdate: (updates: NormalizedPromptUpdates) => void;
  /** The SDK's model slot, or `null` while it loads. */
  modelDefinition: PropDefinition | null;
}

/**
 * The authoring half of the playground, in whichever editor the prompt's
 * {@link PromptStyle} calls for. The SDK adapter picks the style;
 * this only maps it to an editor the client has.
 */
function PlaygroundEditor({ prompt, onUpdate, modelDefinition }: Props) {
  const onQuestionsUpdate = useCallback(
    (updates: QuestionsEditorUpdates) =>
      onUpdate({ ...updates, style: "questions" }),
    [onUpdate],
  );
  const onChatUpdate = useCallback(
    (updates: ChatEditorUpdates) => onUpdate({ ...updates, style: "chat" }),
    [onUpdate],
  );

  switch (prompt.style) {
    case "chat":
      return (
        <ChatPromptEditor
          prompt={prompt}
          onUpdate={onChatUpdate}
          modelDefinition={modelDefinition}
        />
      );
    case "questions":
      return (
        <QuestionsPromptEditor
          prompt={prompt}
          onUpdate={onQuestionsUpdate}
          modelDefinition={modelDefinition}
        />
      );
  }
}

export default memo(PlaygroundEditor);
