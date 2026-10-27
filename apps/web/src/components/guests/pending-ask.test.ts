import { expect, test } from "bun:test";
import type { GuestGrant } from "@repo/protocol/live";
import { Window } from "happy-dom";
import {
  clearGuestAsks,
  clearPendingAsk,
  pendingAskKey,
  readPendingAsk,
} from "./pending-ask";

test("saved asks isolate identities and artifacts, signout clears all drafts, late acknowledgements preserve replacements", () => {
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
    const own = pendingAskKey(grant);
    const otherGuest = pendingAskKey({ ...grant, guestId: "g2" });
    const otherArtifact = pendingAskKey({
      ...grant,
      artifactId: "00000000-0000-4000-8000-000000000002",
    });
    const request = { requestId: "old", text: "Private unsent draft" };
    sessionStorage.setItem(own, JSON.stringify(request));
    expect(readPendingAsk(own)).toEqual(request);
    expect(readPendingAsk(otherGuest)).toBeUndefined();
    expect(readPendingAsk(otherArtifact)).toBeUndefined();
    sessionStorage.setItem(
      own,
      JSON.stringify({ ...request, requestId: "new" })
    );
    clearPendingAsk(own, "old");
    expect(readPendingAsk(own)?.requestId).toBe("new");
    clearPendingAsk(own, "new");
    expect(readPendingAsk(own)).toBeUndefined();
    sessionStorage.setItem(own, JSON.stringify(request));
    sessionStorage.setItem(otherArtifact, JSON.stringify(request));
    sessionStorage.setItem(
      "/api/guest/artifacts/legacy/ask",
      JSON.stringify(request)
    );
    sessionStorage.setItem("unrelated", "keep");
    clearGuestAsks();
    expect(readPendingAsk(own)).toBeUndefined();
    expect(readPendingAsk(otherArtifact)).toBeUndefined();
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
