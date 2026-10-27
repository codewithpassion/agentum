// What the Worker, the frame and the artifact page agree on (A.1). Spec:
// docs/v3/artifacts-prd.md.

import { ARTIFACT_VIEWER_KINDS } from "@repo/db/shared";
import { z } from "zod";

/**
 * What a `hm_view_` token says. `expiresAt` is Unix seconds. `shareId` is set
 * for a link viewer, `userId` for a member.
 */
export const viewTokenClaimsSchema = z.strictObject({
  artifactId: z.uuid(),
  expiresAt: z.int().positive(),
  shareId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  versionId: z.string().min(1),
  viewer: z.enum(ARTIFACT_VIEWER_KINDS),
});
export type ViewTokenClaims = z.infer<typeof viewTokenClaimsSchema>;
