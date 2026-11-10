import { z } from "zod";

/** A row id or public id taken from input. */
export const idString = z.string().min(1).max(200);

/** Matches the slashes at the end of a URL, so a base joins a path cleanly. */
export const TRAILING_SLASHES = /\/+$/;

/** The host of an origin, or null when there is none or it does not parse. */
export const hostOf = (origin: string | null): string | null => {
  if (origin === null) {
    return null;
  }
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};
