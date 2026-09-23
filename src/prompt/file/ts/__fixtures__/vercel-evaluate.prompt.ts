// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { prompts } from "@evalution/vercel-ai-sdk";

interface Ticket {
  subject: string;
  message: string;
}

function buildQuestions() {
  return {
    spam: { type: "boolean" as const, instructions: "Is this spam?" },
  };
}

export default prompts({ id: "support-evaluate" }, ({ openai }) => ({
  triage: (ticket: Ticket, product: string) => ({
    model: typeSafeAi.evaluationModel("jev-latest"),
    state: { ticket },
    questions: {
      department: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: {
          billing: { includes: ["Charges", "Invoices", "Refunds"] },
          technical: ["Bugs", "Outages"],
          other: null,
        },
      },
      severity: {
        type: "score",
        instructions: `How severe is the issue for ${product}?`,
        criteria: ["Cosmetic", "Workaround exists", "Blocking; no workaround"],
      },
      requestsRefund: {
        type: "boolean",
        instructions: "Is the customer requesting money back?",
      },
    },
  }),
  gateway: (ticket: Ticket) => ({
    model: "jev-latest",
    state: ticket.message,
    questions: {
      spam: { type: "boolean", instructions: "Is this spam?" },
    },
  }),
  computed: (ticket: Ticket) => ({
    model: openai.evaluationModel("gpt-5.5"),
    state: ticket,
    questions: buildQuestions(),
  }),
  reply: (ticket: Ticket) => ({
    model: openai("gpt-5.5"),
    system: "Draft a reply.",
    prompt: ticket.message,
  }),
}));
