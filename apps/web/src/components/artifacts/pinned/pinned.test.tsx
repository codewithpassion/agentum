import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "#/components/ui/sidebar";
import { type PinnedArtifact, pinnedHref, sortPinned } from "./pinned-logic.ts";
import { PinnedSidebarGroup } from "./pinned-sidebar.tsx";
import { PinnedDeskTiles } from "./pinned-tiles.tsx";

const pin = (overrides: Partial<PinnedArtifact>): PinnedArtifact => ({
  artifactId: "11111111-1111-4111-8111-111111111111",
  kind: "dashboard",
  position: 1,
  title: "Sales",
  ...overrides,
});

test("sortPinned orders by position and leaves the input alone", () => {
  const input = [
    pin({ position: 3, title: "c" }),
    pin({ position: 1, title: "a" }),
  ];
  expect(sortPinned(input).map((p) => p.title)).toEqual(["a", "c"]);
  expect(input.map((p) => p.title)).toEqual(["c", "a"]);
});

test("pinnedHref points at the viewer", () => {
  expect(pinnedHref(pin({ artifactId: "abc" }))).toBe("/a/abc");
});

test("desk tiles list each pin as a link, and nothing without pins", () => {
  expect(renderToStaticMarkup(<PinnedDeskTiles pins={[]} />)).toBe("");
  const html = renderToStaticMarkup(
    <PinnedDeskTiles
      pins={[
        pin({ position: 2, title: "Second" }),
        pin({ artifactId: "x", position: 1, title: "First" }),
      ]}
    />
  );
  expect(html).toContain('href="/a/x"');
  expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
});

test("the sidebar group lists pins under a Pinned label, and nothing without pins", () => {
  expect(
    renderToStaticMarkup(
      <SidebarProvider>
        <PinnedSidebarGroup pins={[]} />
      </SidebarProvider>
    )
  ).not.toContain("Pinned");
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <PinnedSidebarGroup pins={[pin({ title: "Sales" })]} />
    </SidebarProvider>
  );
  expect(html).toContain("Pinned");
  expect(html).toContain("Sales");
  expect(html).toContain('href="/a/11111111-1111-4111-8111-111111111111"');
});
