import type { AgentTemplateId, AskLevel, VoicePreset } from "@repo/db/shared";
import type { AgentDraft, BuilderCatalog } from "./draft.ts";

export interface BuilderTemplate {
  apps: readonly string[];
  askLevel: AskLevel;
  description: string;
  job: string;
  remember: readonly string[];
  title: string;
  voice: VoicePreset;
}

export const templates = {
  drive_tidy: {
    apps: ["google-drive"],
    askLevel: "everything",
    description:
      "Review shared folders for duplicate files, unclear names, and misplaced documents. Propose a tidy-up plan and ask before moving, renaming, or deleting any file.",
    job: "Review our shared drive this month and propose a plan to tidy it up.",
    remember: [
      "Our folder naming conventions",
      "Folders to leave alone",
      "How long we keep old files",
    ],
    title: "Shared drive tidy",
    voice: "careful",
  },
  inbox_triage: {
    apps: ["gmail"],
    askLevel: "outside",
    description:
      "Sort incoming messages by urgency, highlight what needs a reply, and summarize the rest. Draft replies for review and suggest labels to keep the inbox clear.",
    job: "Every weekday at 8am, sort the inbox and tell me what needs a reply.",
    remember: [
      "Who counts as urgent",
      "Which messages can wait",
      "How to label messages",
    ],
    title: "Inbox triage",
    voice: "brief",
  },
  invoice_filing: {
    apps: ["gmail", "google-drive", "xero"],
    askLevel: "everything",
    description:
      "Find incoming invoices, extract the supplier, amount, and due date, and check for duplicates. Propose a file name, folder, and accounting category for approval before filing anything.",
    job: "Each Friday, collect this week's invoices and prepare them for filing.",
    remember: [
      "Where invoices belong",
      "Our accounting categories",
      "Who approves unusual amounts",
    ],
    title: "Invoice filing",
    voice: "careful",
  },
  lead_research: {
    apps: ["hubspot", "linkedin"],
    askLevel: "rarely",
    description:
      "Research prospective customers and summarize their business, likely needs, and relevant contacts with source links. Separate confirmed facts from guesses and suggest a useful reason to reach out.",
    job: "Research these five companies and tell me which are a good fit for our service.",
    remember: [
      "What makes a good customer",
      "Industries we serve",
      "Companies to leave out",
    ],
    title: "Lead research",
    voice: "careful",
  },
  meeting_follow_up: {
    apps: ["google-calendar", "gmail", "google-drive"],
    askLevel: "outside",
    description:
      "Turn meeting notes into a short recap with decisions, owners, and due dates. Draft a follow-up email and flag actions that have no owner before sharing it.",
    job: "After each client meeting, draft a recap and a list of next steps for me to review.",
    remember: [
      "Where meeting notes live",
      "Who receives each recap",
      "How we record due dates",
    ],
    title: "Meeting follow-up",
    voice: "friendly",
  },
  social_drafts: {
    apps: ["google-drive", "linkedin"],
    askLevel: "outside",
    description:
      "Turn company news and useful customer tips into short social post drafts. Match the company voice, check factual claims, and prepare options for review before publishing.",
    job: "Every Monday, draft three LinkedIn posts from our latest company news for me to review.",
    remember: [
      "Our audience and tone",
      "Topics we avoid",
      "Claims that need a source",
    ],
    title: "Social post drafts",
    voice: "friendly",
  },
  support_first_reply: {
    apps: ["gmail", "google-drive"],
    askLevel: "outside",
    description:
      "Read new support messages and draft a helpful first reply using the support guides. Ask for missing details and flag refunds, sensitive issues, and cases that need a person before sending a reply.",
    job: "Each morning, draft first replies to new support messages for me to approve.",
    remember: [
      "Where support guides live",
      "When to involve a person",
      "What we can promise customers",
    ],
    title: "Support first reply",
    voice: "friendly",
  },
  weekly_report: {
    apps: ["google-drive", "slack", "hubspot"],
    askLevel: "rarely",
    description:
      "Read the week's updates and prepare a short report on progress, numbers, blockers, and next steps. Link to the source of each key claim and call out missing information.",
    job: "Every Friday afternoon, prepare a weekly report for me from our team updates.",
    remember: [
      "Which numbers matter",
      "Where team updates live",
      "Who the report is for",
    ],
    title: "Weekly report",
    voice: "brief",
  },
} as const satisfies Record<AgentTemplateId, BuilderTemplate>;

const askLabels: Record<AskLevel, string> = {
  custom: "custom",
  everything: "Ask before everything",
  outside: "Ask before it acts outside",
  rarely: "Ask rarely",
};

/** Browser-safe, pure starting points; optional apps never block creation. */
export const templateDraft = (
  id: AgentTemplateId,
  catalog: BuilderCatalog
): { raw: AgentDraft; notes: string[] } => {
  const template: BuilderTemplate = templates[id];
  const connected = catalog.connectors.filter(
    (connector) =>
      connector.catalogKey !== undefined &&
      template.apps.includes(connector.catalogKey)
  );
  const connectedKeys = new Set(
    connected.map((connector) => connector.catalogKey)
  );
  return {
    // Job, memory and ask level remain suggestions until their builder fields exist.
    // A suggested job does not create a schedule without the person's review.
    notes: [
      `Suggested job: ${template.job}`,
      ...template.remember.map((item) => `Remember: ${item}`),
      `Asks: ${askLabels[template.askLevel]}`,
      ...template.apps
        .filter((key) => !connectedKeys.has(key))
        .map((key) => `Works with the ${key} app once it is connected`),
    ],
    raw: {
      does: template.description,
      handsTo: [],
      library: [],
      name: template.title,
      rules: [],
      runsOn: null,
      sampleInput: [],
      skills: [],
      startsOn: [],
      tools: connected.map((connector) => connector.id),
      voice: template.voice,
    },
  };
};
