import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberList } from "./member-list.tsx";
import {
  type MemberRow,
  type TeamAgent,
  type TeamPerson,
  UNKNOWN_AGENT,
} from "./team-logic.ts";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const agentRow = (
  label: string,
  overrides: Partial<MemberRow> = {}
): MemberRow => ({
  avatar: { color: "blue", glyph: label.charAt(0) },
  detail: "Answers support email",
  id: `agent_${label.toLowerCase()}`,
  isLead: false,
  isYou: false,
  kind: "agent",
  label,
  ...overrides,
});

const personRow = (
  label: string,
  overrides: Partial<MemberRow> = {}
): MemberRow => ({
  avatar: null,
  detail: "",
  id: `user_${label.toLowerCase()}`,
  isLead: false,
  isYou: false,
  kind: "user",
  label,
  ...overrides,
});

const agent = (name: string, id: string): TeamAgent => ({
  avatar: { color: "teal", glyph: name.charAt(0) },
  id,
  jobLine: "",
  name,
});

const person = (name: string, userId: string): TeamPerson => ({ name, userId });

const render = ({
  addableAgents = [],
  addablePeople = [],
  busy = false,
  canEdit,
  rows,
}: {
  addableAgents?: readonly TeamAgent[];
  addablePeople?: readonly TeamPerson[];
  busy?: boolean;
  canEdit: boolean;
  rows: readonly MemberRow[];
}) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <MemberList
        addableAgents={addableAgents}
        addablePeople={addablePeople}
        busy={busy}
        canEdit={canEdit}
        onAdd={noop}
        onRemove={noop}
        rows={rows}
      />
    </RouterContextProvider>
  );

const BUTTON_TAG = /<button\b[^>]*>/g;
const SELECT_TAG = /<select\b[^>]*>/g;
const MILO_OPTION = /<option [^>]*value="agent_milo"[^>]*>Milo<\/option>/;
const SAM_OPTION = /<option [^>]*value="user_sam"[^>]*>Sam<\/option>/;
const noop = (): undefined => undefined;

test("agents and people render with their labels and job line", () => {
  const html = render({
    canEdit: false,
    rows: [agentRow("Ruby"), personRow("Priya")],
  });
  expect(html).toContain("Ruby");
  expect(html).toContain("Priya");
  expect(html).toContain("Answers support email");
});

test("the lead and you badges show on their rows", () => {
  const html = render({
    canEdit: false,
    rows: [
      agentRow("Ruby", { isLead: true }),
      personRow("Priya", { isYou: true }),
    ],
  });
  expect(html).toContain(">Lead<");
  expect(html).toContain(">You<");
});

test("a known agent name links to its page", () => {
  const html = render({
    canEdit: false,
    rows: [agentRow("Ruby", { id: "agent_1" })],
  });
  expect(html).toContain('href="/agents/agent_1"');
});

test("an unknown agent is not a link", () => {
  const html = render({
    canEdit: false,
    rows: [
      agentRow(UNKNOWN_AGENT, { avatar: null, detail: "", id: "agent_gone" }),
    ],
  });
  expect(html).toContain(UNKNOWN_AGENT);
  expect(html).not.toContain("/agents/agent_gone");
  expect(html).not.toContain("<a ");
});

test("an agent with no avatar shows a question mark", () => {
  const html = render({
    canEdit: false,
    rows: [agentRow("Ruby", { avatar: null })],
  });
  expect(html).toContain(">?<");
  expect(html).toContain("bg-slate-600");
});

test("without edit rights there are no Remove buttons and no Add text", () => {
  const html = render({
    addableAgents: [agent("Milo", "agent_milo")],
    addablePeople: [person("Sam", "user_sam")],
    canEdit: false,
    rows: [agentRow("Ruby"), personRow("Priya")],
  });
  expect(html).not.toContain("Remove");
  expect(html).not.toContain("Add");
  expect(html).not.toContain("<select");
});

test("with edit rights each row has a Remove button and both add forms show", () => {
  const html = render({
    addableAgents: [agent("Milo", "agent_milo")],
    addablePeople: [person("Sam", "user_sam")],
    canEdit: true,
    rows: [agentRow("Ruby"), personRow("Priya")],
  });
  expect(html).toContain('aria-label="Remove Ruby from the team"');
  expect(html).toContain('aria-label="Remove Priya from the team"');
  expect(html).toContain("Add an agent");
  expect(html).toContain("Add a person");
  expect(html).toContain("Choose an agent");
  expect(html).toContain("Choose a person");
  expect(html).toMatch(MILO_OPTION);
  expect(html).toMatch(SAM_OPTION);
  expect(html.split("<select").length - 1).toBe(2);
});

test("the add button is disabled until a choice exists", () => {
  const html = render({
    addableAgents: [agent("Milo", "agent_milo")],
    canEdit: true,
    rows: [],
  });
  const buttons = html.match(BUTTON_TAG) ?? [];
  const addButton = buttons.find((tag) => tag.includes('type="submit"'));
  expect(addButton).toContain("disabled");
});

test("busy disables every button and select", () => {
  const html = render({
    addableAgents: [agent("Milo", "agent_milo")],
    addablePeople: [person("Sam", "user_sam")],
    busy: true,
    canEdit: true,
    rows: [agentRow("Ruby"), personRow("Priya")],
  });
  const buttons = html.match(BUTTON_TAG) ?? [];
  expect(buttons.length).toBe(4);
  for (const tag of buttons) {
    expect(tag).toContain("disabled");
  }
  expect(html.match(SELECT_TAG) ?? []).toEqual([
    expect.stringContaining("disabled"),
    expect.stringContaining("disabled"),
  ]);
});

test("an empty list says no members yet", () => {
  const html = render({ canEdit: false, rows: [] });
  expect(html).toContain("No members yet.");
  expect(html).not.toContain("<li");
});

test("a list with no one left to add says so", () => {
  const html = render({ canEdit: true, rows: [agentRow("Ruby")] });
  expect(html).toContain("Everyone in the workspace is already in this team.");
  expect(html).not.toContain("<select");
});

test("an empty agent list hides only the agent form", () => {
  const html = render({
    addablePeople: [person("Sam", "user_sam")],
    canEdit: true,
    rows: [agentRow("Ruby")],
  });
  expect(html).not.toContain("Add an agent");
  expect(html).toContain("Add a person");
  expect(html).not.toContain("Everyone in the workspace");
});
