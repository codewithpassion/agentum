/** biome-ignore-all lint/performance/noJsxPropsBind: The field uses current controlled input. */
import { useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";

/** Resolves an email to a current authorized member before inserting an explicit chip. */
export function MemberMention({
  artifactId,
  onInsert,
  disabled,
}: {
  artifactId: string;
  onInsert: (token: string) => void;
  disabled?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="my-2 flex flex-wrap items-center gap-2">
      <label>
        Mention member by email
        <input
          aria-label="Mention member by email"
          autoComplete="off"
          disabled={disabled || busy}
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
      </label>
      <button
        disabled={disabled || busy || !email.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const { token } = await getTrpc().liveArtifacts.mentionMember.query(
              { artifactId, email: email.trim() }
            );
            onInsert(token);
            setEmail("");
            setError(undefined);
          } catch {
            setError(
              "Member is not available for this artifact. Try again or check the address."
            );
          } finally {
            setBusy(false);
          }
        }}
        type="button"
      >
        {busy ? "Finding member…" : "Add mention"}
      </button>
      {Boolean(error) && <p role="alert">{error}</p>}
    </div>
  );
}
