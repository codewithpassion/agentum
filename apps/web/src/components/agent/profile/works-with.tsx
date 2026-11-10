import type { ReactNode } from "react";
import { HANDS_TO_COPY, PEERS_COPY, SUBAGENTS_COPY } from "./profile-logic.ts";
import { Row } from "./profile-row.tsx";

function Part({
  children,
  copy,
  title,
}: {
  children: ReactNode;
  copy: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-semibold text-sm">{title}</h3>
      <p className="text-muted-foreground text-xs">{copy}</p>
      {children}
    </div>
  );
}

/** Hands to, Subagents and peers in one block, each with what it does. */
export function WorksWith({
  handsTo,
  peers,
  subagents,
}: {
  handsTo: ReactNode;
  /** Left out where the peers are not loaded, like the map inspector. */
  peers?: ReactNode;
  subagents: ReactNode;
}) {
  return (
    <Row label="Works with">
      <div className="flex flex-col gap-4">
        <Part copy={HANDS_TO_COPY} title="Hands to">
          {handsTo}
        </Part>
        <Part copy={SUBAGENTS_COPY} title="Subagents">
          {subagents}
        </Part>
        {peers === undefined ? null : (
          <Part copy={PEERS_COPY} title="Peers">
            {peers}
          </Part>
        )}
      </div>
    </Row>
  );
}
