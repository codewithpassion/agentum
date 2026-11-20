import { expect, test } from "bun:test";
import { AGENT_AVATAR_COLORS, defaultAgentAvatar } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTile, AVATAR_CLASSES } from "./agent-tile.tsx";

test("the tile draws the stored glyph on the stored colour", () => {
  const html = renderToStaticMarkup(
    <AgentTile avatar={{ color: "green", glyph: "L" }} />
  );
  expect(html).toContain(">L</span>");
  expect(html).toContain("bg-emerald-600");
  expect(html).toContain('aria-hidden="true"');
});

test("two renders of one avatar match at every size but the size classes", () => {
  const avatar = { color: "violet", glyph: "Q" } as const;
  for (const size of ["xs", "sm", "md", "lg", "xl"] as const) {
    const html = renderToStaticMarkup(
      <AgentTile avatar={avatar} size={size} />
    );
    expect(html).toContain("bg-violet-600");
    expect(html).toContain(">Q</span>");
  }
});

test("a size sets the box and an extra class is kept", () => {
  const avatar = { color: "slate", glyph: "?" } as const;
  expect(
    renderToStaticMarkup(<AgentTile avatar={avatar} size="xl" />)
  ).toContain("size-[52px]");
  expect(
    renderToStaticMarkup(<AgentTile avatar={avatar} className="mt-1" />)
  ).toContain("mt-1");
});

test("every avatar colour has a class, and the default avatar of a name renders", () => {
  for (const color of AGENT_AVATAR_COLORS) {
    expect(AVATAR_CLASSES[color].startsWith("bg-")).toBe(true);
  }
  const html = renderToStaticMarkup(
    <AgentTile avatar={defaultAgentAvatar("lunch planner")} />
  );
  expect(html).toContain(">L</span>");
});
