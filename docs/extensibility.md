---
title: Extensibility
description: Extend Evalution with custom prompt sources, SDK adapters, and trace backends.
nav:
  group: Reference
  groupOrder: 3
  order: 2
---

# Extensibility

Evalution is built around a few small interfaces, so you can swap in your own
prompt storage, model SDKs, and trace backends without changing its source code. Each
interface below is fully documented in the [API reference](/docs/extensibility/api/),
generated from the published TypeScript types.

Register your extensions in your project's `.evalution/config.ts` —
see [Configuration](/docs/config).

## Prompt providers

[`PromptProvider`](/docs/extensibility/api/interfaces/PromptProvider.html) implementations
enable listing, reading, watching, and editing prompts in Evalution. The built-in
[`FilePromptProvider`](/docs/extensibility/api/classes/FilePromptProvider.html)
works with files from disk (or any [`FileProvider`](/docs/extensibility/api/interfaces/FileProvider.html) implementation).
Implement [`PromptProvider`](/docs/extensibility/api/interfaces/PromptProvider.html) yourself to work with
prompts from a different source, such as a database or an API.

## SDK adapters

An [`SDKAdapter`](/docs/extensibility/api/interfaces/SDKAdapter.html) maps a
normalized prompt onto a concrete model SDK. Evalution ships
[`VercelAISDK`](/docs/extensibility/api/classes/VercelAISDK.html) (the default) and
[`GeminiInteractionsSDK`](/docs/extensibility/api/classes/GeminiInteractionsSDK.html) (currently experimental).
Implement your own [`SDKAdapter`](/docs/extensibility/api/interfaces/SDKAdapter.html) to work with a different
AI SDK.

## Trace providers

A [`TraceProvider`](/docs/extensibility/api/interfaces/TraceProvider.html) stores and
streams the spans produced when a prompt runs. The in-process
[`MemoryTraceProvider`](/docs/extensibility/api/classes/MemoryTraceProvider.html) is
the default; implement the interface to persist traces to your own backend.

## See also

The full, type-accurate reference — every exported interface, class, and type —
is generated from the source and published alongside these docs:

- [Configuration](/docs/config) — register your providers and adapters.
- [API reference](/docs/extensibility/api/)
