---
title: Configuration
description: Configure Evalution for your project with .evalution/config.ts.
nav:
  group: Reference
  groupOrder: 3
  order: 3
---

# Configuration

Evalution reads a config file from the path `.evalution/config.ts` relative to the root of your project.
It should contain a default export of type [`EvalutionConfig`](/docs/extensibility/api/interfaces/EvalutionConfig.html):

```ts
// .evalution/config.ts
import type { EvalutionConfig } from 'evalution';
import { FilePromptProvider, VercelAISDK } from 'evalution';

export default {
  promptProviders: [
    new FilePromptProvider({
      sdk: new VercelAISDK(),
    }),
  ],
} satisfies EvalutionConfig;
```

If Evalution cannot find a config file, it starts in **onboarding mode** and guides you through creating one.

See the [API reference](/docs/extensibility/api/interfaces/EvalutionConfig.html) for details about the specific configuration options.

## See also

- [Extensibility](/docs/extensibility) — implement custom providers and adapters.
- [API reference](/docs/extensibility/api/)
