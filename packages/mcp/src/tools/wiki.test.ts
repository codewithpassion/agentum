import { expect, test } from "bun:test";
import { textOf } from "../testing";
import { READ_ONLY, WRITE_CREATE, WRITE_UPDATE } from "./define";
import { harbourmasterTools } from "../server";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const page = { path: "wiki/start.md", title: "Start", body: "# Start\n[[Next]]", links: [{ index: 8, slug: "next", title: "Next", path: "wiki/next.md", broken: false }], backlinks: [{ path: "wiki/home.md", title: "Home" }] };

test("wiki_read returns body, resolved links and backlinks", async () => {
  const result = await callTool(fakePorts({ wikiRead: (input) => { expect(input).toEqual({ path: page.path }); return Promise.resolve(page); } }), "wiki_read", { path: page.path });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual(page);
  expect(textOf(result)).toContain("wiki/home.md");
  expect(textOf(result)).toContain("[[Next]]");
});

test("suggest edit forwards body and summary and returns suggestion id", async () => {
  const input = { path: page.path, body: "# New", summary: "Fix title" };
  const result = await callTool(fakePorts({ wikiSuggestEdit: (received) => { expect(received).toEqual(input); return Promise.resolve({ id: "suggestion-1" }); } }), "wiki_suggest_edit", input);
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ suggestionId: "suggestion-1" });
  expect(textOf(result)).toContain("suggestion-1");
});

test("suggest requires a nonempty summary", async () => {
  expect((await callTool(fakePorts(), "wiki_suggest_edit", { path: page.path, body: "", summary: "  " })).isError).toBe(true);
});

test("new tools have read/write annotations for the dry-run gate", () => {
  const tools = harbourmasterTools(fakePorts());
  for (const name of ["library_list", "library_read", "library_versions", "wiki_read"]) expect(tools.find((tool) => tool.name === name)?.annotations).toEqual(READ_ONLY);
  expect(tools.find((tool) => tool.name === "library_write")?.annotations).toEqual(WRITE_UPDATE);
  expect(tools.find((tool) => tool.name === "wiki_suggest_edit")?.annotations).toEqual(WRITE_CREATE);
});
