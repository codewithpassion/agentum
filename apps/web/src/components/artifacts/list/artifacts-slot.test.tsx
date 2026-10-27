import { describe, expect, test } from "bun:test";
import type { ArtifactCard } from "@repo/protocol/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactSlotRows } from "./artifacts-slot.tsx";

const card = (patch: Partial<ArtifactCard>): ArtifactCard => ({
  agentName: null,
  artifactId: "art_1",
  audience: "workspace",
  currentVersion: 3,
  description: null,
  hasThumbnail: false,
  kind: "page",
  linkCount: 0,
  ownerName: null,
  ownerUserId: null,
  pinned: false,
  title: "Quarterly report",
  updatedAt: "2026-10-27T00:00:00.000Z",
  ...patch,
});

describe("ArtifactSlotRows", () => {
  test("renders a link row with title, version and first badge", () => {
    const html = renderToStaticMarkup(
      <ArtifactSlotRows cards={[card({ linkCount: 2 })]} />
    );
    expect(html).toContain('data-testid="slot-artifact"');
    expect(html).toContain('href="/a/art_1"');
    expect(html).toContain("Quarterly report");
    expect(html).toContain("v3");
    expect(html).toContain("Workspace");
    expect(html).not.toContain("Link");
  });

  test("uses the private badge", () => {
    const html = renderToStaticMarkup(
      <ArtifactSlotRows cards={[card({ audience: "private" })]} />
    );
    expect(html).toContain("Private");
  });

  test("renders one row per card", () => {
    const html = renderToStaticMarkup(
      <ArtifactSlotRows
        cards={[
          card({ artifactId: "a", kind: "doc" }),
          card({ artifactId: "b", kind: "app" }),
        ]}
      />
    );
    expect(html.split('data-testid="slot-artifact"')).toHaveLength(3);
    expect(html).toContain('href="/a/b"');
  });

  test("renders nothing for no cards", () => {
    expect(renderToStaticMarkup(<ArtifactSlotRows cards={[]} />)).toBe("");
  });
});
