// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import type React from "react";

function PromptTabIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

interface TabProps {
  id?: string;
  name: string;
  icon?: React.ReactNode;
  active: boolean;
  dirty: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function Tab({
  id,
  name,
  icon,
  active,
  dirty,
  onClick,
  onClose,
  onDragStart,
  onDragEnd,
}: TabProps) {
  return (
    <button
      type="button"
      id={id}
      title={name}
      className={`tab${active ? " tab-active" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="tab-icon">{icon ?? <PromptTabIcon />}</span>
      <span className="tab-label">{name}</span>
      {dirty ? (
        <span className="tab-dirty">●</span>
      ) : (
        <span className="tab-close" onClick={onClose}>
          ×
        </span>
      )}
    </button>
  );
}
