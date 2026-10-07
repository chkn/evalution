// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import { createPortal } from "react-dom";
import { type AgentInfo, OTHER_AGENT_URL } from "../../shared/agent";
import ProviderIcon from "./ProviderIcon";
import { useAnchoredPopover } from "./use-anchored-popover";

interface Props {
  /**
   * Every coding agent, those that can't be launched marked with a
   * `disabledReason`. Nothing renders when empty — a host that can't launch
   * agents at all.
   */
  agents: readonly AgentInfo[];
  /** Launches `agent` about whatever the surrounding view shows. */
  onAsk: (agent: AgentInfo) => void;
}

/**
 * "Ask AI" about what a view shows: a button that drops down every
 * agent — one whose CLI isn't installed greyed out as "Not found" — then, past
 * a separator, "Other", linking to where support for another can be requested.
 */
export function AskAgentButton({ agents, onAsk }: Props) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { triggerRef, popoverRef, style } =
    useAnchoredPopover<HTMLButtonElement>({
      open,
      onClose: close,
      matchTriggerWidth: false,
    });

  if (agents.length === 0) return null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="trace-view-prompt-btn ask-agent-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open a coding agent in a terminal, told what you're viewing"
      >
        <AgentIcon />
        Ask AI
        <ChevronDownIcon />
      </button>
      {open &&
        createPortal(
          <div
            className="trace-header-menu"
            ref={popoverRef}
            style={style}
            role="menu"
          >
            <AskAgentMenuItems
              agents={agents}
              onAsk={agent => {
                close();
                onAsk(agent);
              }}
              labelPrefix=""
            />
            <hr className="ask-agent-menu-divider" />
            <a
              role="menuitem"
              className="trace-header-menu-item"
              href={OTHER_AGENT_URL}
              target="_blank"
              rel="noopener"
              onClick={close}
            >
              <span className="trace-header-menu-item-icon" />
              <span className="trace-header-menu-item-label">Other</span>
            </a>
          </div>,
          document.body,
        )}
    </>
  );
}

interface MenuItemsProps {
  /** The coding agents to list; those with a `disabledReason` are disabled. */
  agents: readonly AgentInfo[];
  /** Launches the chosen agent. */
  onAsk: (agent: AgentInfo) => void;
  /** Put before each agent's name. Defaults to `"Ask "`. */
  labelPrefix?: string;
}

/**
 * One `.trace-header-menu-item` per agent, with its icon and name — the
 * entries of {@link AskAgentButton}'s menu, and of a header's collapsed "More
 * actions" menu, where they stand in for the button. An agent that can't be
 * launched is disabled, saying "Not found", with its reason on hover.
 */
export function AskAgentMenuItems({
  agents,
  onAsk,
  labelPrefix = "Ask ",
}: MenuItemsProps) {
  return agents.map(agent => (
    <button
      key={agent.id}
      type="button"
      role="menuitem"
      className="trace-header-menu-item"
      disabled={!!agent.disabledReason}
      title={agent.disabledReason}
      onClick={() => onAsk(agent)}
    >
      <span className="trace-header-menu-item-icon">
        <ProviderIcon provider={agent.icon} size={14} />
      </span>
      <span className="trace-header-menu-item-label">
        {labelPrefix}
        {agent.label}
      </span>
      {agent.disabledReason && (
        <span className="ask-agent-item-status">Not found</span>
      )}
    </button>
  ));
}

/** A sparkle — a coding agent, when it isn't yet one in particular. */
function AgentIcon() {
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
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
