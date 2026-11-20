import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileInfo, InboxPost } from "#/integrations/trpc/types.ts";
import { RoomPost } from "./room-post.tsx";
import type { RoomMember } from "./room-types.ts";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const agent: RoomMember = {
  avatar: { color: "blue", glyph: "R" },
  handle: "ruby",
  id: "agent_1",
  kind: "agent",
  name: "Ruby",
};

const person: RoomMember = {
  avatar: null,
  handle: "dom",
  id: "user_1",
  kind: "user",
  name: "Dom Fretz",
};

const other: RoomMember = {
  avatar: { color: "teal", glyph: "S" },
  handle: "scout",
  id: "agent_2",
  kind: "agent",
  name: "Scout",
};

const basePost: InboxPost = {
  artifacts: [],
  authorId: "agent_1",
  authorKind: "agent",
  createdAt: "2026-11-19T10:00:00.000Z",
  fileIds: [],
  id: "post_1",
  runId: null,
  text: "Invoice matched.",
  threadId: "thread_1",
};

const reportFile: FileInfo = {
  createdAt: "2026-11-19T10:00:00.000Z",
  id: "file_1",
  mime: "application/pdf",
  name: "report.pdf",
  runId: null,
  size: 2048,
  source: "run",
};

const noFiles: ReadonlyMap<string, FileInfo> = new Map();

const render = (overrides: Partial<Parameters<typeof RoomPost>[0]> = {}) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RoomPost
        assigned={[]}
        author={agent}
        authorLabel="Ruby"
        files={noFiles}
        post={basePost}
        {...overrides}
      />
    </RouterContextProvider>
  );

test("a post with a run, two artifacts and a file links to all of them", () => {
  const html = render({
    files: new Map([[reportFile.id, reportFile]]),
    post: {
      ...basePost,
      artifacts: [
        { id: "art_1", title: "Q3 deck" },
        { id: "art_2", title: "Vendor sheet" },
      ],
      fileIds: ["file_1"],
      runId: "run_1",
    },
  });
  expect(html).toContain('href="/tasks/run_1"');
  expect(html).toContain('href="/a/art_1"');
  expect(html).toContain('href="/a/art_2"');
  expect(html).toContain("Q3 deck");
  expect(html).toContain("Vendor sheet");
  expect(html).toContain('href="/files/file_1"');
  expect(html).toContain("report.pdf");
});

test("a post with no run, artifacts or files renders no links list and no Task pill", () => {
  const html = render();
  expect(html).not.toContain('aria-label="Links"');
  expect(html).not.toContain("Task");
});

test("assigned agents are named on the assigned line", () => {
  const html = render({ assigned: [agent, other] });
  expect(html).toContain('data-testid="assigned-to"');
  expect(html).toContain("Assigned to");
  expect(html).toContain('<span class="font-medium">Ruby</span>');
  expect(html).toContain('<span class="font-medium">Scout</span>');
});

test("an empty assigned list renders no assigned line", () => {
  const html = render({ assigned: [] });
  expect(html).not.toContain('data-testid="assigned-to"');
});

test("a person's post is plain text, so Markdown stays literal", () => {
  const html = render({
    author: person,
    authorLabel: "You",
    post: { ...basePost, authorKind: "user", text: "**x**" },
  });
  expect(html).toContain(
    '<p class="whitespace-pre-wrap text-foreground text-sm">**x**</p>'
  );
  expect(html).not.toContain("<strong>");
});

test("an agent's post renders Markdown", () => {
  const html = render({ post: { ...basePost, text: "**x**" } });
  expect(html).toContain("<strong>x</strong>");
});

test("an agent's avatar shows its glyph", () => {
  const html = render();
  expect(html).toContain(">R</span>");
  expect(html).toContain("bg-blue-600");
});

test("a person without an avatar shows one letter of their name", () => {
  const html = render({ author: person, authorLabel: "You" });
  expect(html).toContain(">D</span>");
  expect(html).not.toContain(">DF</span>");
});

test("a Slack guest's post shows the guest's name, a Slack guest tag and the message only", () => {
  const html = render({
    author: {
      avatar: null,
      handle: null,
      id: "slack:T0TEAM:U0GUEST",
      kind: "user",
      name: "Priya",
    },
    authorLabel: "Priya",
    post: {
      ...basePost,
      authorId: "slack:T0TEAM:U0GUEST",
      authorKind: "user",
      text: "Priya (Slack guest): can we move the call?",
    },
  });
  expect(html).toContain('<span class="font-medium text-sm">Priya</span>');
  expect(html).toContain(
    '<span class="text-muted-foreground text-xs">Slack guest</span>'
  );
  expect(html).toContain("can we move the call?");
  expect(html).not.toContain("(Slack guest):");
});
