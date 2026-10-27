/** Guest HTTP client contracts. Credentials travel only in the HttpOnly cookie.
 * Fetch with credentials: same-origin and Origin on mutations; serialize cookie
 * rotating HTTP requests (a concurrent use of an old credential is refused).
 * Guest image URLs are the artifact-scoped guestUrl, canonical document state
 * retains /files/:id. There is no guest run/approval/export endpoint.
 */
import { z } from "zod";
import type { GuestGrant, LiveJoinResult } from "./live.ts";
export const guestVerifySchema = z.strictObject({ code: z.string().max(100) });
export const guestCommentSchema = z.strictObject({
  body: z.string().trim().min(1).max(4096),
  threadId: z.string().min(1).max(200).optional(),
});
export interface GuestVerifyResult {
  expiresAt: string;
  grant: GuestGrant;
  location: string;
}
export interface GuestOpenResult {
  grant: GuestGrant;
  kind: "document" | "deck";
  revision: number;
  state: number[];
  title: string;
}
export type GuestJoinResult = LiveJoinResult;
export interface GuestImageResult {
  guestUrl: string;
  url: string;
}
export const guestEndpoints = {
  artifact: (
    id: string,
    action:
      | "open"
      | "join"
      | "rotate"
      | "threads"
      | "comment"
      | "resolve"
      | "policy"
      | "images"
      | "room"
      | "session"
  ) => `/api/guest/artifacts/${encodeURIComponent(id)}/${action}`,
  code: (token: string) => `/api/guest/${encodeURIComponent(token)}/code`,
  image: (id: string, file: string) =>
    `/api/guest/artifacts/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`,
  invitation: (token: string) => `/g/${encodeURIComponent(token)}`,
  signout: "/api/guest/signout",
  verify: (token: string) => `/api/guest/${encodeURIComponent(token)}/verify`,
} as const;
