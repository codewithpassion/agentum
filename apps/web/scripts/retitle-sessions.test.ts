import { expect, test } from "bun:test";
import { planRetitles } from "./retitle-sessions-helpers.ts";

test("plans only unreadable non-null stored titles with readable message or agent fallback", () => {
  const result = planRetitles([
    { agentName: "Agent", id: "ok", inputText: "Other", title: "My name" },
    { agentName: "Agent", id: "null", inputText: "Other", title: null },
    {
      agentName: "Agent",
      id: "json",
      inputText: '{"harbourmaster_turn":{"text":"Review it\\nThen reply"}}',
      title: '{"old":1}',
    },
    { agentName: "Agent", id: "markup", inputText: "{}", title: "<b>bad</b>" },
    { agentName: null, id: "marker", inputText: "", title: "[ATTACHMENT:x]" },
    { agentName: "{}", id: "blank", inputText: "[]", title: " " },
    {
      agentName: "Agent",
      id: "envelope",
      inputText: "New",
      title: '{"harbourmaster_turn":{"text":"Old"}}',
    },
  ]);
  expect(result.updates.map(({ id, newTitle }) => ({ id, newTitle }))).toEqual([
    { id: "json", newTitle: "Review it" },
    { id: "markup", newTitle: "Conversation with Agent" },
    { id: "marker", newTitle: "Conversation" },
    { id: "blank", newTitle: "Conversation" },
    { id: "envelope", newTitle: "New" },
  ]);
  expect(result.statements).toHaveLength(5);
});

test("SQL doubles quotes in values and ids and protects concurrent renames", () => {
  const result = planRetitles([
    {
      agentName: null,
      id: "s'1",
      inputText: "It's new",
      title: "<b>it's old</b>",
    },
  ]);
  expect(result.statements).toEqual([
    "UPDATE sessions SET title = 'It''s new' WHERE id = 's''1' AND title = '<b>it''s old</b>';",
  ]);
});
