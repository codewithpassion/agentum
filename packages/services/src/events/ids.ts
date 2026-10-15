import { ulid } from "ulidx";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastMs: number | undefined;
let lastUlid = "";

export function incrementRandom(random: string): string {
  const characters = random.split("");
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const digit = ULID_ALPHABET.indexOf(random.charAt(index));
    if (digit < ULID_ALPHABET.length - 1) {
      characters[index] = ULID_ALPHABET.charAt(digit + 1);
      return characters.join("");
    }
    characters[index] = "0";
  }
  throw new Error("ULID random part overflowed within one millisecond");
}

/** A ULID that sorts after the previous one minted in the same millisecond. */
function monotonicUlid(now: Date | undefined): string {
  if (now !== undefined && !Number.isFinite(now.getTime())) {
    throw new Error("Invalid Date for event ID");
  }
  const ms = now?.getTime() ?? Date.now();
  let id: string;
  if (ms === lastMs) {
    id = `${lastUlid.slice(0, 10)}${incrementRandom(lastUlid.slice(10))}`;
  } else {
    id = ulid(ms);
  }
  lastMs = ms;
  lastUlid = id;
  return id;
}

/** A bare ULID for the `events.id` column, with no prefix. */
export function newEventId(now?: Date): string {
  return monotonicUlid(now);
}
