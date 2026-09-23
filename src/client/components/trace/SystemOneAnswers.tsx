// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { useState } from "react";
import {
  type Answer,
  type ChoiceAnswer,
  choiceRows,
  formatPercent,
  type NoulAnswer,
  type ScoreAnswer,
  scoreLevels,
  scorePosition,
} from "./answers";
import { JsonView } from "./JsonView.tsx";

/**
 * A readout for whichever mark is hovered or focused. Tooltips enhance and
 * never gate: every value here is also in the table view.
 */
function useReadout() {
  const [readout, setReadout] = useState<string | null>(null);
  const bind = (text: string) => ({
    tabIndex: 0,
    "aria-label": text,
    onPointerEnter: () => setReadout(text),
    onPointerLeave: () => setReadout(null),
    onFocus: () => setReadout(text),
    onBlur: () => setReadout(null),
  });
  return { readout, bind };
}

/** A yes/no answer: a 0–1 meter of the probability of yes. */
function NoulChart({ answer }: { answer: NoulAnswer }) {
  return (
    <div className="s1-noul">
      <div
        className="s1-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={answer.noul}
        aria-label={`Probability of yes: ${formatPercent(answer.noul)}`}
      >
        <div
          className="s1-fill s1-emphasis"
          style={{ width: `${answer.noul * 100}%` }}
        />
      </div>
      <span className="s1-value">{formatPercent(answer.noul)} yes</span>
    </div>
  );
}

/** "Confidence 81%", when the provider reported one. */
function confidenceText(answer: ChoiceAnswer | ScoreAnswer): string | null {
  return answer.confidence === undefined
    ? null
    : `confidence ${formatPercent(answer.confidence)}`;
}

/**
 * A choice: one bar per option, the chosen option emphasized — or just the
 * chosen option, when the provider reported no probabilities.
 */
function ChoiceChart({ answer }: { answer: ChoiceAnswer }) {
  const { readout, bind } = useReadout();
  const rows = choiceRows(answer);
  const confidence = confidenceText(answer);
  const caption =
    readout ??
    (confidence && confidence[0].toUpperCase() + confidence.slice(1));
  if (rows.length === 0) {
    return (
      <div className="s1-choice">
        <div className="s1-choice-row chosen">
          <span className="s1-choice-label" title={answer.choice}>
            <span aria-hidden>✓ </span>
            {answer.choice}
          </span>
        </div>
        {caption && <div className="s1-caption">{caption}</div>}
      </div>
    );
  }
  return (
    <div className="s1-choice">
      {rows.map(row => (
        <div
          key={row.label}
          className={`s1-choice-row${row.chosen ? " chosen" : ""}`}
          {...bind(
            `${row.label}: ${formatPercent(row.probability)}${row.chosen ? " (chosen)" : ""}`,
          )}
        >
          <span className="s1-choice-label" title={row.label}>
            {row.chosen && <span aria-hidden>✓ </span>}
            {row.label}
          </span>
          <span className="s1-bar-slot">
            <span
              className={`s1-bar ${row.chosen ? "s1-emphasis" : "s1-muted"}`}
              style={{ width: `${row.probability * 100}%` }}
            />
          </span>
          <span className="s1-value">{formatPercent(row.probability)}</span>
        </div>
      ))}
      {caption && <div className="s1-caption">{caption}</div>}
    </div>
  );
}

/**
 * A score: the distribution over rubric levels as columns (when reported),
 * and the expected score as a marker on the level axis.
 */
function ScoreChart({ answer }: { answer: ScoreAnswer }) {
  const { readout, bind } = useReadout();
  const levels = scoreLevels(answer);
  const distribution = levels.some(l => l.probability !== undefined);
  const peak = Math.max(...levels.map(l => l.probability ?? 0), 0);
  const position = scorePosition(answer.score, levels);
  const confidence = confidenceText(answer);
  return (
    <div className="s1-score">
      {distribution && (
        <div className="s1-columns">
          {levels.map(l => {
            const p = l.probability ?? 0;
            const text = `Level ${l.level}${l.description ? ` · ${l.description}` : ""}: ${formatPercent(p)}`;
            return (
              <div key={l.level} className="s1-column-slot" {...bind(text)}>
                {p === peak && (
                  <span className="s1-column-value">{formatPercent(p)}</span>
                )}
                <span
                  className="s1-column s1-muted"
                  style={{ height: `${p * 100}%` }}
                />
              </div>
            );
          })}
        </div>
      )}
      {levels.length > 0 && (
        <>
          <div className="s1-axis">
            <span
              className="s1-marker s1-emphasis"
              style={{ left: `${position * 100}%` }}
              {...bind(`Expected score ${answer.score.toFixed(1)}`)}
            />
          </div>
          <div className="s1-levels">
            {levels.map(l => (
              <span key={l.level} className="s1-level" title={l.description}>
                <span className="s1-level-number">{l.level}</span>
                {l.description && (
                  <span className="s1-level-description">{l.description}</span>
                )}
              </span>
            ))}
          </div>
        </>
      )}
      <div className="s1-caption">
        {readout ??
          [`Expected ${answer.score.toFixed(1)}`, confidence]
            .filter(Boolean)
            .join(" · ")}
      </div>
    </div>
  );
}

function AnswerChart({ answer }: { answer: Answer }) {
  switch (answer.type) {
    case "noul":
      return <NoulChart answer={answer} />;
    case "choice":
      return <ChoiceChart answer={answer} />;
    case "score":
      return <ScoreChart answer={answer} />;
  }
}

/**
 * Answers to typed questions — a System One call's or an AI SDK evaluation's,
 * as `readAnswers` reads them — one small chart per question, with the answers
 * a toggle away as the table view.
 */
export function SystemOneAnswers({
  answers,
  raw: recorded,
}: {
  answers: Record<string, Answer>;
  /** The output as recorded, shown in the table view. */
  raw: unknown;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="s1-answers">
      <div className="s1-toolbar">
        <button
          type="button"
          className="s1-toggle"
          aria-pressed={raw}
          onClick={e => {
            e.stopPropagation();
            setRaw(r => !r);
          }}
        >
          {raw ? "Charts" : "Data"}
        </button>
      </div>
      {raw ? (
        <JsonView data={recorded} />
      ) : (
        Object.entries(answers).map(([id, answer]) => (
          <section key={id} className="s1-question">
            <h4 className="s1-question-id">{id}</h4>
            <AnswerChart answer={answer} />
          </section>
        ))
      )}
    </div>
  );
}
