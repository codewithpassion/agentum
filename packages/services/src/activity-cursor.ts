import { ServiceError } from "./errors.ts";

const SEPARATOR = "~";

/** A list cursor: the activity time and id of the last row of a page. */
export const activityCursor = (at: string, id: string): string =>
  `${at}${SEPARATOR}${id}`;

export const parseActivityCursor = (
  cursor: string
): { at: string; id: string } => {
  const [at, id] = cursor.split(SEPARATOR);
  if (!(at && id)) {
    throw new ServiceError("invalid", "Invalid cursor");
  }
  return { at, id };
};
