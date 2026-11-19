import { expect, test } from "bun:test";
import { planRetitles } from "./retitle-sessions-helpers.ts";

test("plans only unreadable non-null stored titles with readable message or agent fallback", () => {
  const result = planRetitles([
    { id: "ok", title: "My name", inputText: "Other", agentName: "Agent" },
    { id: "null", title: null, inputText: "Other", agentName: "Agent" },
    { id: "json", title: '{"old":1}', inputText: '{"harbourmaster_turn":{"text":"Review it\\nThen reply"}}', agentName: "Agent" },
    { id: "markup", title: "<b>bad</b>", inputText: "{}", agentName: "Agent" },
    { id: "marker", title: "[ATTACHMENT:x]", inputText: "", agentName: null },
    { id: "blank", title: " ", inputText: "[]", agentName: "{}" },
    { id: "envelope", title: '{"harbourmaster_turn":{"text":"Old"}}', inputText: "New", agentName: "Agent" },
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
  const result = planRetitles([{ id: "s'1", title: "<b>it's old</b>", inputText: "It's new", agentName: null }]);
  expect(result.statements).toEqual([
    "UPDATE sessions SET title = 'It''s new' WHERE id = 's''1' AND title = '<b>it''s old</b>';",
  ]);
});
