/** biome-ignore-all lint/performance/noJsxPropsBind: Acceptance fixture controls. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { getTrpc } from "#/integrations/trpc/client";
import { MemberMention } from "../../../live-artifacts/member-mention";
import { ElementAskViewer } from "../../element-ask-viewer";

import "./fixture.css";

const params = new URLSearchParams(window.location.search);
const contentUrl = params.get("contentUrl") ?? "";
const documentId = params.get("documentId") ?? "";
function Fixture() {
  const [body, setBody] = useState("");
  const [posted, setPosted] = useState(false);
  return (
    <main>
      <div style={{ height: "70vh" }}>
        <ElementAskViewer
          contentUrl={contentUrl}
          interactive
          preview={params.get("preview") === "true"}
          title="Dashboard"
          version={{ createdAt: "2026-10-27T00:00:00Z", number: 1 }}
          viewer="member"
        />
      </div>
      <label>
        Comment
        <textarea
          aria-label="Comment"
          onChange={(event) => setBody(event.target.value)}
          value={body}
        />
      </label>
      <MemberMention
        artifactId={documentId}
        onInsert={(token) => setBody((old) => `${old} ${token}`)}
      />
      <button
        onClick={async () => {
          await getTrpc().liveArtifacts.comment.mutate({
            artifactId: documentId,
            body,
          });
          setPosted(true);
        }}
        type="button"
      >
        Post comment
      </button>
      {Boolean(posted) && <p role="status">Comment posted</p>}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture root");
}
createRoot(root).render(<Fixture />);
