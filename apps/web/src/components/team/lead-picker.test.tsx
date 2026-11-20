import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadPicker } from "./lead-picker.tsx";

const noop = async (): Promise<void> => undefined;

const choices = [
  { id: "agent-1", label: "Scout" },
  { id: "agent-2", label: "Writer" },
];

const SELECT_OPENING = /<select[^>]*>/;
const SCOUT_OPTION = /<option[^>]*>Scout<\/option>/;
const NO_LEAD_OPTION = /<option[^>]*value=""[^>]*>No lead<\/option>/;

const render = (props: {
  canEdit: boolean;
  choices?: readonly { id: string; label: string }[];
  leadId: string | null;
}) =>
  renderToStaticMarkup(
    <LeadPicker
      canEdit={props.canEdit}
      choices={props.choices ?? choices}
      leadId={props.leadId}
      onChange={noop}
    />
  );

test("the select offers No lead and each agent, labelled Lead", () => {
  const html = render({ canEdit: true, leadId: null });
  expect(html).toContain('for="team-lead"');
  expect(html).toContain("Lead</label>");
  expect(html).toMatch(NO_LEAD_OPTION);
  expect(html).toContain('value="agent-1"');
  expect(html).toContain('value="agent-2"');
  expect(html).toContain(
    "The lead hears room messages that name nobody, and hands the work out."
  );
});

test("the current lead's option is selected", () => {
  const html = render({ canEdit: true, leadId: "agent-1" });
  expect(html.match(SCOUT_OPTION)?.[0]).toContain("selected");
  expect(html.match(NO_LEAD_OPTION)?.[0]).not.toContain("selected");
});

test("an empty team disables the select and says how to add an agent", () => {
  const html = render({ canEdit: true, choices: [], leadId: null });
  expect(html.match(SELECT_OPENING)?.[0]).toContain("disabled");
  expect(html).toContain("Add an agent to the team to choose a lead.");
});

test("a reader sees the lead's name, or No lead", () => {
  expect(render({ canEdit: false, leadId: "agent-1" })).toContain(
    "Lead: Scout"
  );
  const none = render({ canEdit: false, leadId: null });
  expect(none).toContain("No lead.");
  expect(none).not.toContain("<select");
});

test("a reader sees Unknown agent for a lead that is not in the team", () => {
  expect(render({ canEdit: false, leadId: "gone" })).toContain(
    "Lead: Unknown agent"
  );
});
