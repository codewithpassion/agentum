/** biome-ignore-all lint/performance/noJsxPropsBind: Test fixture callbacks make excluded app surfaces fail visibly. */
/** An actual network provider over the real workerd room's explicit test issuer.
 * Not an app route and never imported by production. */

import { type LiveJoinResult, liveRoleSchema } from "@repo/protocol/live";
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { DocumentEditor } from "../../document-editor";
import { TicketedRoom } from "../../room-provider";
import "../../../../styles.css";

const query = new URLSearchParams(window.location.search);
const participant = query.get("participant") ?? "alice";
const roomName = query.get("room") ?? "desktop";
async function call(path: string, input: object = {}): Promise<unknown> {
  const response = await fetch(`${path}?room=${encodeURIComponent(roomName)}`, {
    body: JSON.stringify(input),
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Room fixture request failed: ${response.status}`);
  }
  return response.json();
}
function exposeEditor(editor: Editor | null) {
  Reflect.set(window, "roomFixtureEditor", editor);
}
function NetworkEditor() {
  const [room, setRoom] = useState<TicketedRoom>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const provider = new TicketedRoom({
      failed: (message) => {
        setError(message);
        setRoom(undefined);
      },
      join: async (): Promise<LiveJoinResult> => {
        const stats = z
          .object({ fixture: z.record(z.string(), z.unknown()) })
          .parse(await call("/stats"));
        const role = liveRoleSchema.parse(
          stats.fixture[`role:${participant}`] ?? "owner"
        );
        return {
          participant: {
            color: "#123456",
            id: participant,
            kind: "member",
            name: `Trusted ${participant}`,
          },
          role,
          roomUrl: `/socket?room=${encodeURIComponent(roomName)}`,
          ticket: z
            .string()
            .parse(await call("/ticket", { participantId: participant, role })),
        };
      },
      policy: async () => {
        const stats = z
          .object({ fixture: z.record(z.string(), z.unknown()) })
          .parse(await call("/stats"));
        return new Set(z.array(z.string()).parse(stats.fixture.urls));
      },
      ready: (connected) => {
        Reflect.set(window, "roomFixtureProvider", connected);
        setRoom(connected);
      },
      roleChanged: () => {
        /* This fixture tests initial writable admission. */
      },
    });
    provider.connect();
    return () => {
      provider.dispose();
      setTimeout(() => provider.document.destroy(), 0);
    };
  }, []);
  return (
    <main>
      {error !== undefined && <p role="alert">{error}</p>}
      {room === undefined ? (
        <p>Connecting actual room…</p>
      ) : (
        <DocumentEditor
          document={room.document}
          history={{
            downloadMarkdown: () =>
              Promise.reject(
                new Error("Export belongs to the full app acceptance")
              ),
            list: () =>
              Promise.reject(
                new Error("History belongs to the full app acceptance")
              ),
            restore: () =>
              Promise.reject(
                new Error("Restore belongs to the full app acceptance")
              ),
          }}
          onAskAgent={() => setError("Ask belongs to the full app acceptance")}
          onCommentSelection={() =>
            setError("Comments belong to the full app acceptance")
          }
          onEditorReady={exposeEditor}
          policy={room.policy}
          provider={room.presence}
          role={room.role}
          uploadImage={() =>
            Promise.reject(
              new Error("Uploads belong to the full app acceptance")
            )
          }
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing room fixture root");
}
createRoot(root).render(<NetworkEditor />);
