/** Trusted ports only: never populate these records from a submitted message. */
import {
  type SpeakerEnvelope,
  serializeSpeakerEnvelope,
} from "@repo/protocol/live";
import type { Actor } from "./runs/subject.ts";

type Turn = SpeakerEnvelope["harbourmaster_turn"];
export interface SpeakerContext {
  actor: Actor;
  name: string;
  role: string;
}
export interface SpeakerRoom {
  artifact?: Turn["artifact"];
  present: NonNullable<Turn["present"]>;
  where?: Turn["where"];
}
/** Actor comes from authentication; room metadata comes from the authorized session/room port. */
export const buildSpeakerEnvelope = (
  speaker: SpeakerContext,
  room: SpeakerRoom,
  via: Turn["via"],
  text: string
): string => {
  if (!["user", "guest", "agent"].includes(speaker.actor.kind)) {
    throw new Error("Unsupported speaker actor");
  }
  return serializeSpeakerEnvelope({
    harbourmaster_turn: {
      artifact: room.artifact,
      from: {
        id: speaker.actor.id,
        kind:
          speaker.actor.kind === "user"
            ? "member"
            : (speaker.actor.kind as "guest" | "agent"),
        name:
          speaker.name.trim() ||
          (speaker.actor.kind === "guest" ? "Guest" : "Person"),
        role: speaker.role,
      },
      present: room.present.some(
        (p) =>
          p.id !== speaker.actor.id ||
          (p.kind !== undefined &&
            p.kind !==
              (speaker.actor.kind === "user" ? "member" : speaker.actor.kind))
      )
        ? room.present
        : undefined,
      text,
      via,
      where: room.where,
    },
  });
};
