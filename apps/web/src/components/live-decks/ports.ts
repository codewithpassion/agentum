import type { Deck } from "@repo/live-deck";

export interface DeckWhere {
  elementIds: string[];
  slideId: string;
  slideNumber: number;
}
export interface PresentationPosition {
  build: number;
  slideId: string;
}
/** Identity and coordinates have already been authenticated/validated by the room. */
export interface DeckParticipant {
  color: string;
  id: string;
  kind: "member" | "guest" | "agent";
  name: string;
  pointer?: { x: number; y: number };
  selection?: string[];
  slideId?: string;
  status?: string;
}
export interface DeckEditorPorts {
  ask: (where: DeckWhere) => Promise<void>;
  comment: (where: DeckWhere) => Promise<void>;
  /** Trusted local replica constructed with the production richTextCodec. */
  deck: Deck;
  history: () => Promise<void>;
  ownsBlob: (path: string) => boolean;
  participants: readonly DeckParticipant[];
  /** Trusted room broadcast. Null clears spotlight. Local users may leave it. */
  presentation?: PresentationPosition | null;
  presentToEveryone: (position: PresentationPosition | null) => Promise<void>;
  provider: {
    state: "connecting" | "synced" | "disconnected" | "rejected";
    /** Publish ephemeral location only; the room supplies identity. */
    publishPresence: (location: {
      slideId?: string;
      selection: string[];
      pointer?: { x: number; y: number };
    }) => void;
  };
  role: "owner" | "editor" | "commenter" | "viewer";
  selfId: string;
  upload: (file: File) => Promise<{ path: string }>;
}
export const canEditDeck = (ports: DeckEditorPorts) =>
  (ports.role === "owner" || ports.role === "editor") &&
  ports.provider.state === "synced" &&
  ports.deck.doc.getMap("meta").has("theme");
