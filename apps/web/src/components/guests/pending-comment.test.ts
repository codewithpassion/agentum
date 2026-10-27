import { expect, test } from "bun:test";
import type { GuestGrant } from "@repo/protocol/live";
import { Window } from "happy-dom";
import { clearGuestAsks } from "./pending-ask";
import {
  clearPendingComment,
  pendingCommentKey,
  readPendingComment,
} from "./pending-comment";

test("saved addressed comments isolate identities and artifacts, signout clears all drafts, late acknowledgements preserve replacements", () => {
  const window = new Window();
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage"
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: window.sessionStorage,
  });
  try {
    const grant: GuestGrant = {
      artifactId: "00000000-0000-4000-8000-000000000001",
      expiresAt: "2030-01-01T00:00:00.000Z",
      guestId: "g1",
      role: "editor",
      workspaceId: "w1",
    };
    const own = pendingCommentKey(grant);
    const otherGuest = pendingCommentKey({ ...grant, guestId: "g2" });
    const otherArtifact = pendingCommentKey({
      ...grant,
      artifactId: "00000000-0000-4000-8000-000000000002",
    });
    const request = {
      body: "Private unsent comment",
      requestId: "old",
      toAgent: true,
    };
    sessionStorage.setItem(own, JSON.stringify(request));
    expect(readPendingComment(own)).toEqual(request);
    expect(readPendingComment(otherGuest)).toBeUndefined();
    expect(readPendingComment(otherArtifact)).toBeUndefined();
    sessionStorage.setItem(
      own,
      JSON.stringify({ ...request, requestId: "new" })
    );
    clearPendingComment(own, "old");
    expect(readPendingComment(own)?.requestId).toBe("new");
    clearPendingComment(own, "new");
    expect(readPendingComment(own)).toBeUndefined();
    sessionStorage.setItem(own, JSON.stringify(request));
    sessionStorage.setItem(otherArtifact, JSON.stringify(request));
    sessionStorage.setItem(
      "/api/guest/artifacts/legacy/ask",
      JSON.stringify(request)
    );
    sessionStorage.setItem("unrelated", "keep");
    clearGuestAsks();
    expect(readPendingComment(own)).toBeUndefined();
    expect(readPendingComment(otherArtifact)).toBeUndefined();
    expect(
      sessionStorage.getItem("/api/guest/artifacts/legacy/ask")
    ).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "sessionStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
    window.close();
  }
});
