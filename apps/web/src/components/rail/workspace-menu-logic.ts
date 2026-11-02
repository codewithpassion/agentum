export interface WorkspaceChoice {
  current: boolean;
  id: string;
  name: string;
}

/** One workspace the person belongs to, as the server returns it. */
export interface MyWorkspace {
  clerkOrgId: string;
  role: string;
  workspaceId: string;
}

/** One organisation the person belongs to, as Clerk's client lists it. */
export interface ClerkOrgName {
  id: string;
  name: string;
}

const CANNOT_SWITCH_MESSAGE = "Could not switch workspace.";
const ADMIN_ROLE = "org:admin";

/**
 * Menu rows for the workspaces the server lists for the person. The server
 * list decides which workspaces appear. Clerk supplies the names, so a rename
 * shows, and an org Clerk does not list falls back to its id.
 */
export function workspaceChoices({
  mine,
  orgs,
  activeOrgId,
}: {
  mine: MyWorkspace[];
  orgs: ClerkOrgName[];
  activeOrgId: string | null;
}): WorkspaceChoice[] {
  const namesById = new Map(orgs.map((org) => [org.id, org.name]));
  const choices = mine.map((workspace) => {
    const name = namesById.get(workspace.clerkOrgId)?.trim();
    return {
      current: workspace.clerkOrgId === activeOrgId,
      id: workspace.clerkOrgId,
      name: name ? name : workspace.clerkOrgId,
    };
  });

  return choices.sort((a, b) => {
    if (a.current !== b.current) {
      return a.current ? -1 : 1;
    }
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (byName !== 0) {
      return byName;
    }
    return a.id.localeCompare(b.id);
  });
}

/** Only an org admin of the active workspace may create a workspace. */
export function canCreateWorkspace({
  mine,
  activeOrgId,
}: {
  mine: MyWorkspace[];
  activeOrgId: string | null;
}): boolean {
  const active = mine.find((workspace) => workspace.clerkOrgId === activeOrgId);
  return active?.role === ADMIN_ROLE;
}

/** Text for a failed switch: the error's message, or the default when there is none. */
export function switchErrorMessage(error: unknown): string {
  let text = "";
  if (error instanceof Error) {
    text = error.message;
  } else if (typeof error === "string") {
    text = error;
  }
  const trimmed = text.trim();
  return trimmed === "" ? CANNOT_SWITCH_MESSAGE : trimmed;
}
