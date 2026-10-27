/** biome-ignore-all lint/suspicious/useAwait: Async React act flushes queued hook effects and promises. */
/** biome-ignore-all lint/performance/noJsxPropsBind: Regression harness drives real attachment state transitions. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LiveCommentThread } from "@repo/protocol/live";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentThread } from "./collaboration-panel";
import { TicketedRoom } from "./room-provider";
import { useAgentAttachment } from "./use-agent-attachment";

const dom = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
function room() {
  return new TicketedRoom({
    failed: () => {
      throw new Error("Must not connect");
    },
    join: () =>
      Promise.reject(new Error("Static panel regression must not connect")),
    policy: () =>
      Promise.reject(
        new Error("Static panel regression must not fetch policy")
      ),
    ready: () => {
      throw new Error("Must not connect");
    },
    roleChanged: () => {
      throw new Error("Must not connect");
    },
  });
}
test("addressed thread and ordinary replies do not invent per-comment retryable dispatch state", () => {
  const provider = room();
  const thread: LiveCommentThread = {
    anchor: null,
    answeredAt: null,
    artifactId: "artifact",
    comments: ["original", "ordinary-reply"].map((id) => ({
      authorId: "person",
      authorKind: "user",
      body: id,
      createdAt: "2026-10-27T00:00:00Z",
      deletedAt: null,
      editedAt: null,
      id,
      runId: null,
      threadId: "thread",
    })),
    id: "thread",
    quote: null,
    resolvedAt: null,
    resolvedBy: null,
    toAgent: true,
  };
  try {
    const html = renderToStaticMarkup(
      <CommentThread
        artifactId="artifact"
        canComment
        editor={null}
        onSaved={() => Promise.resolve()}
        room={provider}
        thread={thread}
      />
    );
    expect(html).toContain("original");
    expect(html).toContain("ordinary-reply");
    expect(html).toContain("Post reply");
    expect(html).not.toContain("Retry agent delivery");
  } finally {
    provider.dispose();
    provider.document.destroy();
  }
});
test("a successful selection ask consumes both attached context and room cursor before transcript refresh", async () => {
  const provider = room();
  provider.awareness.setLocalState({});
  let refreshed = false;
  const refresh = () => {
    refreshed = true;
    return Promise.resolve();
  };
  function Harness() {
    const { selection, setSelection, sent } = useAgentAttachment(
      provider,
      refresh
    );
    return (
      <>
        <output>{selection ? "ask_agent" : "artifact_thread"}</output>
        <button
          onClick={() => {
            const selected = {
              end: { assoc: -1, tname: "content" },
              start: { tname: "content" },
              text: "selected words",
            };
            provider.select(selected.start, selected.end);
            setSelection(selected);
          }}
          type="button"
        >
          Attach
        </button>
        <button onClick={sent} type="button">
          Accepted send
        </button>
      </>
    );
  }
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      host.querySelectorAll("button")[0]?.click();
    });
    expect(host.querySelector("output")?.textContent).toBe("ask_agent");
    expect(provider.awareness.getLocalState()?.cursor).toBeDefined();
    await act(async () => {
      host.querySelectorAll("button")[1]?.click();
    });
    expect(host.querySelector("output")?.textContent).toBe("artifact_thread");
    expect(provider.awareness.getLocalState()?.cursor).toBeNull();
    expect(refreshed).toBe(true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    provider.dispose();
    provider.document.destroy();
  }
});
