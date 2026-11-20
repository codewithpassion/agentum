// The room digest a team's last dream wrote, for the catch-up slot of a woken
// agent's input (`inbox/wake-input.ts`). Null when the team has none.
import type { Database } from "@repo/db";
import { teams } from "@repo/db/schema/teams";
import { eq } from "drizzle-orm";
import type { LibraryService } from "../../library.ts";
import { readTeamDigest } from "../../memory/team.ts";
import { teamDreamPrincipal } from "./team.ts";

export const roomDigestOf = async (
  db: Database,
  library: Pick<LibraryService, "read">,
  teamId: string
): Promise<string | null> => {
  const [team] = await db
    .select({
      archivedAt: teams.archivedAt,
      folderPath: teams.folderPath,
      workspaceId: teams.workspaceId,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (!team?.folderPath || team.archivedAt !== null) {
    return null;
  }
  return await readTeamDigest(
    library,
    teamDreamPrincipal({ id: teamId, workspaceId: team.workspaceId }),
    team.folderPath
  );
};
