import { expect, test } from "bun:test";
import type { ProposedTrigger } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftReview } from "./draft-review.tsx";

const noop = () => undefined;
const SAVING_BUTTON = /<button[^>]*disabled=""[^>]*>Saving\.\.\.<\/button>/;

const routineDraft: ProposedTrigger = {
  asksBefore: null,
  cron: "0 9 * * 5",
  deliversTo: null,
  does: "Summarise support tickets",
  source: "routine",
  timezone: "Europe/Zurich",
  when: "Every Friday at 9:00",
};

const render = (
  overrides: Partial<Parameters<typeof DraftReview>[0]> & {
    draft: ProposedTrigger;
  }
) =>
  renderToStaticMarkup(
    <DraftReview
      error={null}
      onDiscard={noop}
      onEdit={noop}
      onOpenKeys={noop}
      onSave={noop}
      saving={false}
      {...overrides}
    />
  );

test("a routine draft shows its heading, chips, schedule and three actions", () => {
  const html = render({ draft: routineDraft });
  expect(html).toContain('aria-label="Draft job"');
  expect(html).toContain("Review this job");
  expect(html).toContain('data-chip="when"');
  expect(html).toContain("Every Friday at 9:00");
  expect(html).toContain('data-chip="does"');
  expect(html).toContain("Summarise support tickets");
  expect(html).toContain("0 9 * * 5 (Europe/Zurich)");
  expect(html).toContain(">Save job<");
  expect(html).toContain(">Edit first<");
  expect(html).toContain(">Discard<");
  expect(html).not.toContain(">Open Keys<");
});

test("a routine draft without a timezone shows the cron alone", () => {
  const html = render({
    draft: { ...routineDraft, timezone: null },
  });
  expect(html).toContain("0 9 * * 5</p>");
  expect(html).not.toContain("(null)");
});

test("an http draft saves without Edit first and explains the secret", () => {
  const html = render({
    draft: {
      ...routineDraft,
      cron: null,
      source: "http",
      timezone: null,
    },
  });
  expect(html).toContain(">Save job<");
  expect(html).toContain(">Discard<");
  expect(html).toContain(
    "Saving gives you a web address and a secret. Anything that calls it starts this agent."
  );
  expect(html).not.toContain(">Edit first<");
});

test("a mail draft offers Open Keys and no Save job", () => {
  const html = render({
    draft: {
      ...routineDraft,
      cron: null,
      source: "mail",
      timezone: null,
    },
  });
  expect(html).toContain(">Open Keys<");
  expect(html).toContain(">Discard<");
  expect(html).toContain(
    "Mail starts are set up under Keys. Open Keys to turn on this agent&#x27;s mail address."
  );
  expect(html).not.toContain(">Save job<");
});

test("an app-source draft is unsupported and has no Save job", () => {
  const html = render({
    draft: {
      ...routineDraft,
      cron: null,
      source: "app",
      timezone: null,
    },
  });
  expect(html).toContain("This kind of job cannot be saved here.");
  expect(html).toContain(">Discard<");
  expect(html).not.toContain(">Save job<");
  expect(html).not.toContain(">Open Keys<");
});

test("a routine draft with no cron is unsupported", () => {
  const html = render({
    draft: { ...routineDraft, cron: null },
  });
  expect(html).toContain("This kind of job cannot be saved here.");
  expect(html).not.toContain(">Save job<");
  expect(html).not.toContain(">Edit first<");
});

test("saving disables Save job and shows Saving...", () => {
  const html = render({ draft: routineDraft, saving: true });
  expect(html).toMatch(SAVING_BUTTON);
  expect(html).not.toContain(">Save job<");
});

test("an error renders as an alert", () => {
  const html = render({
    draft: routineDraft,
    error: "The job could not be saved.",
  });
  expect(html).toContain('role="alert"');
  expect(html).toContain("The job could not be saved.");
});

test("agentName renders after the heading", () => {
  const html = render({ agentName: "Sorter", draft: routineDraft });
  expect(html).toContain(" for Sorter");
});
