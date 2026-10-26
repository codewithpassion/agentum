export interface MembershipLike {
  organization: { id: string };
}

/**
 * Returns the organisation id when the user has exactly one organisation
 * membership, and undefined otherwise. Both the loaded list and the total
 * count must say one. Callers must also wait until the list has loaded, since
 * a list still being fetched reads as empty. Used to activate the user's only
 * organisation after an Agent Task sign-in.
 */
export const soleOrganizationId = (
  data: readonly MembershipLike[] | undefined,
  count: number | undefined
): string | undefined => {
  if (data === undefined || count !== 1 || data.length !== 1) {
    return;
  }
  return data[0]?.organization.id;
};
