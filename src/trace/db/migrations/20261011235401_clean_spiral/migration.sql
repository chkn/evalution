-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (c) 2026 Alexander Corrado

ALTER TABLE `spans` ADD `llm_cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `spans` ADD `llm_cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `spans` ADD `llm_cost_cache_read` real;--> statement-breakpoint
ALTER TABLE `spans` ADD `llm_cost_cache_write` real;
