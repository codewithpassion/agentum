import { expect, test } from "bun:test";
import type { ArtifactCard } from "@repo/protocol/artifacts";
import { renderInRoom } from "../test-fixtures.tsx";
import { type MadeFile, MadeToday } from "./made-today.tsx";

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

const file = (path: string, size: number): MadeFile => ({
  path,
  runId: "run_1",
  size,
});

const countOf = (html: string, needle: string): number =>
  html.split(needle).length - 1;

test("renders nothing when there are no files and no artifacts", () => {
  expect(renderInRoom(<MadeToday artifacts={[]} files={[]} />)).toBe("");
});

test("renders base names, sizes and the artifact title", () => {
  const html = renderInRoom(
    <MadeToday
      artifacts={[card({ artifactId: "art_9", title: "Churn dashboard" })]}
      files={[file("reports/q4/summary.md", 1536), file("data/rows.csv", 300)]}
    />
  );
  expect(countOf(html, 'data-testid="made-file"')).toBe(2);
  expect(html).toContain(">summary.md<");
  expect(html).toContain(">rows.csv<");
  expect(html).toContain("1.5 KB");
  expect(html).toContain("300 B");
  expect(html).toContain('title="reports/q4/summary.md"');
  expect(html).toContain("Churn dashboard");
  expect(html).not.toContain("more");
});

test("shows five files and an 'and 2 more' line for seven files", () => {
  const files = Array.from({ length: 7 }, (_, index) =>
    file(`out/file-${index + 1}.txt`, 10)
  );
  const html = renderInRoom(<MadeToday artifacts={[]} files={files} />);
  expect(countOf(html, 'data-testid="made-file"')).toBe(5);
  expect(html).toContain("file-5.txt");
  expect(html).not.toContain("file-6.txt");
  expect(html).toContain("and 2 more");
});

test("shows five artifacts and an 'and 1 more' line for six artifacts", () => {
  const artifacts = Array.from({ length: 6 }, (_, index) =>
    card({ artifactId: `art_${index + 1}`, title: `Doc ${index + 1}` })
  );
  const html = renderInRoom(<MadeToday artifacts={artifacts} files={[]} />);
  expect(countOf(html, 'data-testid="slot-artifact"')).toBe(5);
  expect(html).not.toContain("Doc 6");
  expect(html).toContain("and 1 more");
});

test("renders the card with artifacts and no made-file entry", () => {
  const html = renderInRoom(
    <MadeToday artifacts={[card({ title: "Only artifact" })]} files={[]} />
  );
  expect(html).toContain('data-testid="now-made-today"');
  expect(html).toContain('aria-label="Made today"');
  expect(html).toContain("Only artifact");
  expect(html).not.toContain('data-testid="made-file"');
});
