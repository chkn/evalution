// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import { prompts } from "@evalution/typesafe-sdk";
import { choice, noul, score } from "@typesafe-ai/sdk";

interface Ticket {
  subject: string;
  body: string;
}

function buildQuestions() {
  return { spam: noul("Is this spam?") };
}

export default prompts({ id: "support-triage" }, () => ({
  triage: (ticket: Ticket, product: string) => ({
    state: { ticket },
    questions: {
      refund_requested: noul(
        `Does the customer ask for a refund for ${product}?`,
      ),
      team: choice("Which team should handle this?", {
        billing: "Payments and refunds",
        technical: null,
      }),
      frustration: score("How frustrated is the customer?", [
        "Calm",
        "Frustrated",
        "Very angry",
      ]),
    },
  }),
  objects: (ticket: Ticket) => ({
    model: "jev-latest",
    state: ticket.body,
    questions: {
      spam: { type: "noul", instructions: "Is this spam?" },
      tone: {
        type: "choice",
        instructions: "What is the tone?",
        criteria: { polite: null, rude: null },
      },
    },
  }),
  computed: (ticket: Ticket) => ({
    state: ticket,
    questions: buildQuestions(),
  }),
}));
