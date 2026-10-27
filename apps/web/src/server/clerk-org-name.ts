// Clerk, as workspaces need it: the name of an organisation. Kept apart from
// compose.ts so that file stays free of Clerk imports and bun can test it.
import { createClerkClient } from "@clerk/backend";

/** How long an answer is reused, so a name Clerk lacks does not cost a call per request. */
const TTL_MS = 300_000;

/** The parts of a Clerk organisation the lookup reads. */
export interface OrgSource {
  getOrganization: (params: {
    organizationId: string;
  }) => Promise<{ name: string }>;
}

/** The name of a Clerk organisation, cached per isolate. Errors propagate and are not cached. */
export const cachedOrgName = (
  source: OrgSource,
  now: () => number = Date.now
): ((clerkOrgId: string) => Promise<string | null>) => {
  const answers = new Map<string, { expiresAt: number; name: string | null }>();
  return async (clerkOrgId) => {
    const hit = answers.get(clerkOrgId);
    if (hit && hit.expiresAt > now()) {
      return hit.name;
    }
    const { name } = await source.getOrganization({
      organizationId: clerkOrgId,
    });
    const trimmed = name.trim() || null;
    answers.set(clerkOrgId, { expiresAt: now() + TTL_MS, name: trimmed });
    return trimmed;
  };
};

const lookups = new Map<string, ReturnType<typeof cachedOrgName>>();

/** The cached organisation-name lookup for a Clerk secret key, one per isolate. */
export const clerkOrgName = (secretKey: string) => {
  let lookup = lookups.get(secretKey);
  if (!lookup) {
    const clerk = createClerkClient({ secretKey });
    lookup = cachedOrgName({
      getOrganization: (params) => clerk.organizations.getOrganization(params),
    });
    lookups.set(secretKey, lookup);
  }
  return lookup;
};
