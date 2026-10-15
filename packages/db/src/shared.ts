// Safe to import from browser code: no driver, no Node APIs. Everything the UI
// needs from this package lives here; the other entries pull in drizzle.

/**
 * How a note leaves this package: plain JSON. Server functions serialize
 * their results, so the row's numeric id becomes a string and the timestamp
 * stays an ISO string.
 */
export interface Note {
  createdAt: string;
  id: string;
  text: string;
}

export const NOTE_TEXT_MAX_LENGTH = 280;
