import { expect, test } from "bun:test";
import { agentumTools } from "../server";
import { textOf } from "../testing";
import { READ_ONLY, WRITE_CREATE, WRITE_UPDATE } from "./define";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const page = {
  backlinks: [{ path: "wiki/home.md", title: "Home" }],
  body: "# Start\n[[Next]]",
  links: [
    {
      broken: false,
      index: 8,
      path: "wiki/next.md",
      slug: "next",
      title: "Next",
    },
  ],
  path: "wiki/start.md",
  title: "Start",
};

test("wiki_read returns body, resolved links and backlinks", async () => {
  const result = await callTool(
    fakePorts({
      wikiRead: (input) => {
        expect(input).toEqual({ path: page.path });
        return Promise.resolve(page);
      },
    }),
    "wiki_read",
    { path: page.path }
  );
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual(page);
  expect(textOf(result)).toContain("wiki/home.md");
  expect(textOf(result)).toContain("[[Next]]");
});

test("suggest edit forwards body and summary and returns suggestion id", async () => {
  const input = { body: "# New", path: page.path, summary: "Fix title" };
  const result = await callTool(
    fakePorts({
      wikiSuggestEdit: (received) => {
        expect(received).toEqual(input);
        return Promise.resolve({ id: "suggestion-1" });
      },
    }),
    "wiki_suggest_edit",
    input
  );
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual({ suggestionId: "suggestion-1" });
  expect(textOf(result)).toContain("suggestion-1");
});

test("suggest requires a nonempty summary", async () => {
  let called = false;
  const ports = fakePorts({
    wikiSuggestEdit: () => {
      called = true;
      return Promise.resolve({ id: "unexpected" });
    },
  });
  expect(
    (
      await callTool(ports, "wiki_suggest_edit", {
        body: "",
        path: page.path,
        summary: "  ",
      })
    ).isError
  ).toBe(true);
  expect(called).toBe(false);
});

test("new tools have read/write annotations for the dry-run gate", () => {
  const tools = agentumTools(fakePorts());
  for (const name of [
    "library_list",
    "library_read",
    "library_versions",
    "wiki_read",
  ]) {
    expect(tools.find((tool) => tool.name === name)?.annotations).toEqual(
      READ_ONLY
    );
  }
  expect(
    tools.find((tool) => tool.name === "library_write")?.annotations
  ).toEqual(WRITE_UPDATE);
  expect(
    tools.find((tool) => tool.name === "wiki_suggest_edit")?.annotations
  ).toEqual(WRITE_CREATE);
});

test("read-only callers retain the new reads and omit the new writes", () => {
  const names = agentumTools(fakePorts(), { readOnly: true }).map(
    (tool) => tool.name
  );
  for (const name of [
    "library_list",
    "library_read",
    "library_versions",
    "wiki_read",
  ]) {
    expect(names).toContain(name);
  }
  for (const name of ["library_write", "wiki_suggest_edit"]) {
    expect(names).not.toContain(name);
  }
});
