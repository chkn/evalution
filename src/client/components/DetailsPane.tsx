// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The details pane shared by the trace view (a selected span) and the
 * dataset view (a selected row): a side pane when there's room, a bottom pane
 * otherwise, with a title, actions, a close button and an id line, over
 * icon + label + value facts and labelled blocks.
 */

import { useCallback } from "react";
import { useContentRectTest } from "./use-content-rect-test";

/**
 * `true` once the observed element is at least `minWidth` wide. Backs the
 * details pane's layout: a side pane alongside the content when there's room
 * for one, a bottom pane below it otherwise. See {@link useContentRectTest}.
 */
export function useIsWide(minWidth: number) {
  const { ref, matches: isWide } = useContentRectTest(
    useCallback(rect => rect.width >= minWidth, [minWidth]),
  );
  return { ref, isWide };
}

/**
 * The pane itself: beside the content (`side`) or below it (`bottom`) — see
 * {@link useIsWide}.
 */
export function DetailsPane({
  placement,
  label,
  children,
}: {
  placement: "side" | "bottom";
  /** An accessible name for the pane. */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        placement === "side"
          ? "trace-details-pane"
          : "trace-details-bottom-pane"
      }
      aria-label={label}
    >
      {children}
    </section>
  );
}

/** The pane's title row, its actions and close button, and an id beneath. */
export function DetailsPaneHeader({
  title,
  actions,
  id,
  onClose,
}: {
  title: React.ReactNode;
  /** Shown before the close button. */
  actions?: React.ReactNode;
  /** A monospaced id line under the title. */
  id?: string;
  onClose: () => void;
}) {
  return (
    <>
      <div className="trace-details-pane-header">
        <div className="trace-details-pane-title">{title}</div>
        <div className="trace-details-pane-actions">
          {actions}
          <button
            type="button"
            className="trace-details-pane-close"
            onClick={onClose}
            aria-label="Close details"
          >
            ×
          </button>
        </div>
      </div>
      {id && <code className="trace-details-pane-id">{id}</code>}
    </>
  );
}

/** One icon + label + value line in a {@link FactGroup}. */
export interface Fact {
  label: string;
  icon: React.ReactNode;
  value: React.ReactNode;
}

/**
 * Groups of facts on one grid, so every group's labels line up on a column
 * no wider than the longest label actually on screen.
 */
export function FactsGrid({ children }: { children: React.ReactNode }) {
  return <div className="span-details-facts-grid">{children}</div>;
}

/**
 * One group of facts inside a {@link FactsGrid}, separated from the next by a
 * blank line. `children` go after the facts, full width.
 */
export function FactGroup({
  facts,
  children,
}: {
  facts: Fact[];
  children?: React.ReactNode;
}) {
  return (
    <div className="span-details-facts">
      {facts.map(fact => (
        <div
          key={fact.label}
          className="span-details-fact"
          role="group"
          aria-label={fact.label}
        >
          <span className="span-details-fact-icon">{fact.icon}</span>
          <span className="span-details-fact-label">{fact.label}</span>
          <span className="span-details-fact-value">{fact.value}</span>
        </div>
      ))}
      {children}
    </div>
  );
}

/** A labelled block: a heading over a JSON tree or other wide content. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`span-details-row${className ? ` ${className}` : ""}`}>
      <div className="span-details-row-label">{label}</div>
      <div className="span-details-row-value">{children}</div>
    </div>
  );
}
