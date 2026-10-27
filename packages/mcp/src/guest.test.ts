import { expect, test } from "bun:test";
import { createGuestMcpServer, type GuestToolScope } from "./guest";
import type { LivePort } from "./ports";
import { connectClient } from "./testing";

const artifactId = "00000000-0000-4000-8000-000000000001";
const scope: GuestToolScope = { artifactId, kind: "document", role: "editor" };
const ports = () => {
  const calls: string[] = [];
  const refused = (): Promise<never> =>
    Promise.reject(new Error("Direct mutation forbidden"));
  const live: LivePort = {
    comment: refused,
    comments: refused,
    create: refused,
    edit: refused,
    read: () => {
      calls.push("read");
      return Promise.resolve({
        artifactId,
        blocks: [],
        deletedBlockIds: [],
        present: [],
        revision: 1,
      });
    },
  };
  return { calls, live };
};
test("real MCP transport lists only artifact tools, rejects unknown tools and foreign artifacts", async () => {
  const h = ports();
  const connection = await connectClient(
    createGuestMcpServer({
      authorize: () => Promise.resolve(scope),
      live: h.live,
      scope,
    })
  );
  try {
    const listed = (await connection.client.listTools()).tools.map(
      (tool) => tool.name
    );
    expect(listed).toEqual([
      "document_read",
      "document_comment",
      "document_comments",
    ]);
    const read = await connection.client.callTool({
      arguments: { artifactId },
      name: "document_read",
    });
    expect(read.isError).not.toBe(true);
    const foreign = await connection.client.callTool({
      arguments: { artifactId: "00000000-0000-4000-8000-000000000002" },
      name: "document_read",
    });
    expect(foreign.isError).toBe(true);
    await expect(
      connection.client.callTool({
        arguments: { command: "env" },
        name: "bash",
      })
    ).rejects.toThrow("not found");
    expect(h.calls).toEqual(["read"]);
  } finally {
    await connection.close();
  }
});
test("guest-agent edit requires a dedicated suggestion port and current editor role", async () => {
  const h = ports();
  let current = scope;
  let pending = 0;
  const connection = await connectClient(
    createGuestMcpServer({
      authorize: () => Promise.resolve(current),
      live: h.live,
      scope,
      suggestions: {
        document: () => {
          pending += 1;
          return Promise.resolve({
            changeId: "pending",
            revision: 2,
            skipped: [],
          });
        },
      },
    })
  );
  try {
    expect(
      (await connection.client.listTools()).tools.map((tool) => tool.name)
    ).toContain("document_edit");
    const input = {
      artifactId,
      ops: [{ content: { text: "Suggested" }, op: "insert" }],
    };
    expect(
      (
        await connection.client.callTool({
          arguments: input,
          name: "document_edit",
        })
      ).isError
    ).not.toBe(true);
    expect(pending).toBe(1);
    current = { ...scope, role: "commenter" };
    expect(
      (
        await connection.client.callTool({
          arguments: input,
          name: "document_edit",
        })
      ).isError
    ).toBe(true);
    expect(pending).toBe(1);
  } finally {
    await connection.close();
  }
});
test("deck guest gets only deck reads while suggestion application is absent", async () => {
  const refused = (): Promise<never> =>
    Promise.reject(new Error("Unsupported"));
  const connection = await connectClient(
    createGuestMcpServer({
      authorize: () => Promise.resolve({ ...scope, kind: "deck" }),
      deck: { read: refused, write: refused },
      scope: { ...scope, kind: "deck" },
    })
  );
  try {
    expect(
      (await connection.client.listTools()).tools.map((tool) => tool.name)
    ).toEqual(["deck_read"]);
  } finally {
    await connection.close();
  }
});

test("a role loss during read IO withholds the returned artifact data", async () => {
  const h = ports();
  let ended = false;
  const connection = await connectClient(
    createGuestMcpServer({
      authorize: () =>
        ended
          ? Promise.reject(new Error("Access ended"))
          : Promise.resolve(scope),
      live: {
        ...h.live,
        read: () => {
          ended = true;
          return Promise.resolve({
            artifactId,
            blocks: [],
            deletedBlockIds: [],
            present: [],
            revision: 1,
          });
        },
      },
      scope,
    })
  );
  try {
    expect(
      (
        await connection.client.callTool({
          arguments: { artifactId },
          name: "document_read",
        })
      ).isError
    ).toBe(true);
  } finally {
    await connection.close();
  }
});
