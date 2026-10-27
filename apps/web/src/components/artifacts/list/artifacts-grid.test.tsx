import { expect, test } from "bun:test";
import type { ArtifactCard } from "@repo/protocol/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactCardView } from "./artifact-card.tsx";
import { ArtifactsGrid, appendPage } from "./artifacts-grid.tsx";

const ID_A = "2f6c1c5e-8a52-4f6e-9d57-3f2a7d9b1c10";
const ID_B = "3a7d2d6f-9b63-4a7f-8e68-4a3b8e0c2d21";
const ID_C = "4b8e3e70-0c74-4b80-9f79-5b4c9f1d3e32";

const card = (over: Partial<ArtifactCard> = {}): ArtifactCard => ({
  agentName: null,
  artifactId: ID_A,
  audience: "private",
  currentVersion: 1,
  description: null,
  hasThumbnail: false,
  kind: "page",
  linkCount: 0,
  ownerName: "Dana",
  ownerUserId: "user1",
  pinned: false,
  title: "Quarterly plan",
  updatedAt: "2026-10-27T08:00:00.000Z",
  ...over,
});

const noMore = () => Promise.resolve({ items: [] });

test("card links to the viewer and shows title, version and date before hydration", () => {
  const html = renderToStaticMarkup(
    <ArtifactCardView card={card({ currentVersion: 3 })} nowMs={null} />
  );
  expect(html).toContain('data-testid="artifact-card"');
  expect(html).toContain(`href="/a/${ID_A}"`);
  expect(html).toContain("Quarterly plan");
  expect(html).toContain("v3 · 2026-10-27");
});

test("card shows elapsed time once nowMs is known", () => {
  const html = renderToStaticMarkup(
    <ArtifactCardView
      card={card()}
      nowMs={Date.parse("2026-10-27T10:00:00.000Z")}
    />
  );
  expect(html).toContain("v1 · 2 h ago");
});

test("card with a thumbnail renders the image and no kind icon", () => {
  const html = renderToStaticMarkup(
    <ArtifactCardView card={card({ hasThumbnail: true })} nowMs={null} />
  );
  expect(html).toContain(`src="/api/artifacts/${ID_A}/thumbnail"`);
  expect(html).toContain('loading="lazy"');
  expect(html).not.toContain("artifact-kind-icon");
});

test("card without a thumbnail renders the kind icon and no image", () => {
  const html = renderToStaticMarkup(
    <ArtifactCardView card={card({ kind: "dashboard" })} nowMs={null} />
  );
  expect(html).toContain('data-testid="artifact-kind-icon"');
  expect(html).not.toContain("<img");
});

test("card shows owner and agent, and falls back to owner alone", () => {
  const withAgent = renderToStaticMarkup(
    <ArtifactCardView card={card({ agentName: "Scout" })} nowMs={null} />
  );
  expect(withAgent).toContain("Dana · made by Scout");
  const alone = renderToStaticMarkup(
    <ArtifactCardView card={card()} nowMs={null} />
  );
  expect(alone).not.toContain("made by");
});

test("card audience badges cover Private, Workspace and Link", () => {
  const priv = renderToStaticMarkup(
    <ArtifactCardView card={card()} nowMs={null} />
  );
  expect(priv).toContain("Private");
  expect(priv.match(/artifact-audience/g)?.length).toBe(1);
  const shared = renderToStaticMarkup(
    <ArtifactCardView
      card={card({ audience: "workspace", linkCount: 2 })}
      nowMs={null}
    />
  );
  expect(shared).toContain("Workspace");
  expect(shared).toContain("Link");
  expect(shared.match(/artifact-audience/g)?.length).toBe(2);
});

test("grid renders one card per item and no Load more without next", () => {
  const html = renderToStaticMarkup(
    <ArtifactsGrid
      filters={{}}
      initial={{ items: [card(), card({ artifactId: ID_B })] }}
      loadMore={noMore}
      nowMs={null}
    />
  );
  expect(html).toContain('data-testid="artifacts-grid"');
  expect(html.match(/data-testid="artifact-card"/g)?.length).toBe(2);
  expect(html).not.toContain("artifacts-more");
});

test("grid shows Load more when there is a next cursor", () => {
  const html = renderToStaticMarkup(
    <ArtifactsGrid
      filters={{}}
      initial={{ items: [card()], next: "cursor-1" }}
      loadMore={noMore}
      nowMs={null}
    />
  );
  expect(html).toContain('data-testid="artifacts-more"');
  expect(html).toContain("Load more");
});

test("empty grid explains filters when some are set", () => {
  const html = renderToStaticMarkup(
    <ArtifactsGrid
      filters={{ kind: "doc" }}
      initial={{ items: [] }}
      loadMore={noMore}
      nowMs={null}
    />
  );
  expect(html).toContain('data-testid="artifacts-empty"');
  expect(html).toContain("No artifacts match these filters.");
  expect(html).not.toContain("artifacts-grid");
});

test("empty grid without filters invites agents to publish", () => {
  const html = renderToStaticMarkup(
    <ArtifactsGrid
      filters={{}}
      initial={{ items: [] }}
      loadMore={noMore}
      nowMs={null}
    />
  );
  expect(html).toContain("No artifacts yet.");
  expect(html).toContain(
    "Agents publish pages, docs and dashboards here, and they appear in this list."
  );
});

test("appendPage appends new cards in order and skips ones already shown", () => {
  const a = card();
  const b = card({ artifactId: ID_B });
  const c = card({ artifactId: ID_C });
  expect(appendPage([a, b], [b, c]).map((x) => x.artifactId)).toEqual([
    ID_A,
    ID_B,
    ID_C,
  ]);
  expect(appendPage([a], [c, c])).toHaveLength(2);
  expect(appendPage([], [])).toEqual([]);
});
