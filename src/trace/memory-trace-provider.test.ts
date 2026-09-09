// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { MemoryTraceProvider } from "./memory-trace-provider.ts";
import { runTraceProviderContractTests } from "./trace-provider-contract.ts";

runTraceProviderContractTests(
  "MemoryTraceProvider",
  async opts => new MemoryTraceProvider(opts),
);
