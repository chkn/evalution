// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { prompts } from "@evalution/typesafe-sdk";
import { noul } from "@typesafe-ai/sdk";

interface Ticket {
  subject: string;
  body: string;
}

export default prompts({ id: "support-edit" }, () => ({
  triage: (ticket: Ticket, product: string) => ({
    state: "",
    questions: {
      refund_requested: noul(`Is this about ${product}?`),
    },
  }),
}));
