/**
 * What the desk reads to put A2A decisions in Needs you. Types only, so the
 * desk depends on this shape and not on the services that fill it.
 */
import type { Principal } from "../workspaces.ts";
import type { ConnectionSummary } from "./connections.ts";

/** A message from a peer that waits for a person to approve it. */
export interface WaitingMessage {
  agentId: string;
  connectionId: string;
  createdAt: string;
  /** The host the peer lives on, or null for an outside client that has no URL we know. */
  host: string | null;
  /** The organisation the peer claims, as stored. Null when it names none. */
  org: string | null;
  /** The peer's agent name or the label a person gave it. */
  peer: string;
  taskId: string;
  /** The full text the peer sent. Outside input. */
  text: string;
}

/** What the desk needs from the A2A services. */
export interface A2aNeedsYouSource {
  connections: {
    list: (principal: Principal) => Promise<ConnectionSummary[]>;
  };
  tasks: {
    listWaiting: (principal: Principal) => Promise<WaitingMessage[]>;
  };
}
