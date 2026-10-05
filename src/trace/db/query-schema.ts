// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

/**
 * The trace database's schema as an ad-hoc query's author needs it: the
 * tables of `./schema.ts`, with what each column holds and in what units.
 * Served by `TursoTraceProvider.getQuerySchema` to the REST API and the MCP
 * server. A test checks every column of `./schema.ts` is described here.
 */

/** The trace database's tables, described for someone writing SQL against them. */
export const TRACE_QUERY_SCHEMA = `\
-- Trace database (SQLite). Timestamps are milliseconds since the Unix epoch.
-- Columns marked JSON hold JSON text; read into them with json_extract(),
-- e.g. json_extract(llm_parameters, '$.temperature').

-- One row per trace: a single run, e.g. one prompt execution.
CREATE TABLE traces (
  id          TEXT PRIMARY KEY,
  provider_id TEXT,              -- the trace provider that recorded it
  name        TEXT NOT NULL,     -- usually the prompt's name
  start_time  REAL NOT NULL,     -- ms since epoch
  end_time    REAL,              -- ms since epoch; NULL while running
  status      TEXT NOT NULL,     -- 'running' | 'ok' | 'error'
  attributes  TEXT               -- JSON object of free-form attributes
);

-- One row per span. Spans form a tree per trace via parent_id.
CREATE TABLE spans (
  id                    TEXT PRIMARY KEY,
  trace_id              TEXT NOT NULL,  -- traces.id
  parent_id             TEXT,           -- spans.id; NULL for the root span
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL,  -- 'LLM' | 'TOOL' | 'AGENT' | 'EMBEDDING' | 'DEFAULT'
  start_time            REAL NOT NULL,  -- ms since epoch
  end_time              REAL,           -- ms since epoch; NULL while running
  status                TEXT,           -- 'ok' | 'error'; NULL while running
  error_message         TEXT,
  llm_provider          TEXT,           -- e.g. 'openai', 'anthropic'
  llm_model             TEXT,           -- e.g. 'gpt-4o'
  llm_finish_reason     TEXT,           -- e.g. 'stop', 'length', 'tool-calls'
  llm_prompt_tokens     INTEGER,
  llm_completion_tokens INTEGER,
  llm_total_tokens      INTEGER,
  llm_cost_prompt       REAL,           -- USD
  llm_cost_completion   REAL,           -- USD
  llm_input             TEXT,           -- JSON: an array of messages {role, content}, or any JSON object
  llm_output            TEXT,           -- JSON: always encoded, so a text output is a JSON string
  llm_parameters        TEXT,           -- JSON object of model parameters (temperature, ...)
  attributes            TEXT,           -- JSON object of free-form attributes
  resource              TEXT,           -- JSON object: the OTel resource that produced the span ("service.name", "deployment.environment.name" = 'playground' for runs evalution made, ...)
  prompt                TEXT,           -- JSON {id, providerId?, version?, variation?, functionInputs?, executeInputs?, ...}: the prompt this span ran
  tool                  TEXT            -- JSON {toolName, input, output?} for TOOL spans
);

-- Notes left on a trace, or on one span of it.
CREATE TABLE annotations (
  id         TEXT PRIMARY KEY,
  trace_id   TEXT NOT NULL,   -- traces.id
  span_id    TEXT,            -- spans.id; NULL for a note on the whole trace
  kind       TEXT NOT NULL,   -- 'issue' | 'good' | 'note'
  note       TEXT NOT NULL,
  source     TEXT NOT NULL,   -- 'user' | 'claude-code' | 'codex' | 'agent'
  created_at REAL NOT NULL    -- ms since epoch
);
`;
