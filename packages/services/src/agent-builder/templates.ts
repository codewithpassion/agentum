import type { AgentTemplateId, VoicePreset } from "@repo/db/shared";

export interface BuilderTemplate {
  description: string;
  title: string;
  voice: VoicePreset;
}

export const templates = {
  chase_invoices: {
    description:
      "Find overdue invoices and draft polite reminders for the people who owe them.",
    title: "Chase late invoices",
    voice: "friendly",
  },
  research_topic: {
    description:
      "Research a topic, compare reliable sources, and summarize findings with links.",
    title: "Research a topic",
    voice: "careful",
  },
  sort_inbox: {
    description:
      "Sort incoming messages, highlight what needs a reply, and summarize the rest.",
    title: "Sort an inbox",
    voice: "brief",
  },
} as const satisfies Record<AgentTemplateId, BuilderTemplate>;
