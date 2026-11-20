import type { AgentKeySecret } from "@repo/db/shared";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { SecretsPanel } from "#/components/agent/profile/sheets/secrets.tsx";
import type { AgentRecord } from "#/integrations/trpc/types";
import { RoomSection } from "../section.tsx";

const secretWords = (secret: AgentKeySecret): string =>
  `${secret.name} (${secret.kind === "proxy" ? "added to its requests" : "set as an environment variable"})`;

/** The Keys tab's secrets: which ones the agent is granted, and the panel that grants them. */
export function SecretsSection({
  agent,
  secrets,
}: {
  agent: AgentRecord;
  /** Null when the read model did not load: the summary line is left out. */
  secrets: AgentKeySecret[] | null;
}) {
  const router = useRouter();
  const refresh = useCallback(() => router.invalidate(), [router]);
  return (
    <RoomSection title="Passwords and keys">
      {secrets === null ? null : (
        <p className="text-sm">
          {secrets.length === 0
            ? "No secrets are granted to this agent yet."
            : `Granted: ${secrets.map(secretWords).join(", ")}`}
        </p>
      )}
      <SecretsPanel agent={agent} onChanged={refresh} />
    </RoomSection>
  );
}
