#!/usr/bin/env bun
// Seeds the local database that `bun run dev` in apps/web uses with a team room
// for the fake Slack walkthrough: three fake-runtime agents, each with its own
// Slack app in the fake's workspace, the Slack user linked to the dev user, and
// a "Launch" team led by Ada, made through the teams service so it has its
// `teams/launch` folder and its agents' grants and can dream. It links no channel, because the walkthrough does
// that in the UI. A second run changes nothing it already has and repairs what
// is missing. Progress and errors go to stderr, and the summary goes to stdout
// as JSON. Run from the repo root:
// `bun scripts/dev/seed-slack-room.ts [--clerk-user <id>]`.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { type Statement, sqliteAtomic } from "@repo/db/atomic";
import { createAgentsService } from "@repo/services/agents";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { systemClock } from "@repo/services/runs/types";
import { slackSecretBinding } from "@repo/services/slack/apps";
import type { FakeSlackApp } from "@repo/services/slack/fake-slack";
import { createTeamsService } from "@repo/services/teams";
import type { Principal } from "@repo/services/workspaces";
import { and, eq, or } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  DEV_PERSON_EMAIL,
  DEV_SLACK_USER,
  SEEDED_AGENTS,
  SLACK_TEAM_ID,
} from "./fake-slack-config.ts";
import {
  devUserPrincipal,
  ENV_FILE,
  LocalError,
  localEvents,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "./local.ts";
import { requireSecretsKey } from "./seed-slack-app.ts";

// The boundary lint keeps `@repo/db/schema/*` to services, so this script
// declares the columns it reads and writes. Keep them in step with
// packages/db/src/schema/slack.ts, teams.ts, library.ts and workspaces.ts.
const slackApps = sqliteTable("slack_apps", {
  agentId: text("agent_id").notNull(),
  appId: text("app_id").notNull(),
  botToken: text("bot_token"),
  botUserId: text("bot_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  signingSecret: text("signing_secret").notNull(),
  status: text("status").notNull(),
  teamId: text("team_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
const identityLinks = sqliteTable("identity_links", {
  clerkUserId: text("clerk_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  email: text("email").notNull(),
  externalUserId: text("external_user_id").notNull(),
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  teamId: text("team_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
const teams = sqliteTable("teams", {
  folderPath: text("folder_path"),
  id: text("id").primaryKey(),
});
const libraryEntries = sqliteTable("library_entries", {
  etag: text("etag"),
  kind: text("kind").notNull(),
  mtime: text("mtime").notNull(),
  parent: text("parent").notNull(),
  path: text("path").notNull(),
  size: integer("size").notNull(),
  updatedById: text("updated_by_id").notNull(),
  updatedByKind: text("updated_by_kind").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
const teamSlackLinks = sqliteTable("team_slack_links", {
  teamId: text("team_id").notNull(),
});

const IDENTITY_PROVIDER = "slack";
const TEAM_NAME = "Launch";
const TEAM_SLUG = "launch";
const LEAD_SLUG = "ada";
const AGENT_RUNTIME = "fake";
const AGENT_MODEL = "fake";
const AGENT_INSTRUCTIONS = "Answers in the team room.";
const CLERK_USERS_URL = "https://api.clerk.com/v1/users";
const DEV_LOGIN_EMAIL_KEY = "DEV_LOGIN_EMAIL";
const CLERK_SECRET_KEY = "CLERK_SECRET_KEY";

export interface SlackRoomAgent {
  agentId: string;
  slug: string;
}

export interface SlackRoomSummary {
  agents: SlackRoomAgent[];
  teamId: string;
}

export interface SeedSlackRoomInput {
  clerkUserId: string;
  db: Database;
  /** Base64 of the 32-byte `SECRETS_KEY`. */
  secretsKey: string;
  workspaceId: string;
}

const installSlackAppStatements = async (
  db: Database,
  key: CryptoKey,
  workspaceId: string,
  agentId: string,
  app: FakeSlackApp
): Promise<Statement[]> => {
  const conflicts = await db
    .select({
      agentId: slackApps.agentId,
      appId: slackApps.appId,
      id: slackApps.id,
      teamId: slackApps.teamId,
    })
    .from(slackApps)
    .where(
      and(
        eq(slackApps.workspaceId, workspaceId),
        or(
          eq(slackApps.appId, app.appId),
          and(
            eq(slackApps.agentId, agentId),
            eq(slackApps.teamId, SLACK_TEAM_ID)
          )
        )
      )
    );
  // Keep the row that already holds this app for this agent, so a rerun keeps
  // its id. Slack messages reference that id, so the row cannot be deleted.
  const kept = conflicts.find(
    (row) =>
      row.appId === app.appId &&
      row.agentId === agentId &&
      row.teamId === SLACK_TEAM_ID
  );
  const id = kept?.id ?? crypto.randomUUID();
  const binding = { id, workspaceId };
  const secrets = {
    botToken: await encryptSecret(
      key,
      slackSecretBinding(binding, "bot_token"),
      app.token
    ),
    botUserId: app.botUserId,
    signingSecret: await encryptSecret(
      key,
      slackSecretBinding(binding, "signing_secret"),
      app.signingSecret
    ),
    status: "installed",
  };
  const replaced = conflicts
    .filter((row) => row.id !== id)
    .map((row) => db.delete(slackApps).where(eq(slackApps.id, row.id)));
  if (kept) {
    return [
      ...replaced,
      db.update(slackApps).set(secrets).where(eq(slackApps.id, id)),
    ];
  }
  return [
    ...replaced,
    db.insert(slackApps).values({
      ...secrets,
      agentId,
      appId: app.appId,
      createdAt: new Date().toISOString(),
      id,
      teamId: SLACK_TEAM_ID,
      workspaceId,
    }),
  ];
};

/** Makes the three agents, one per SEEDED_AGENTS entry, or finds them by slug. */
const ensureAgents = async (
  db: Database,
  principal: Principal
): Promise<SlackRoomAgent[]> => {
  const agents = createAgentsService({ db, events: localEvents(db) });
  const existing = await agents.list(principal, { includeArchived: true });
  return Promise.all(
    SEEDED_AGENTS.map(async (seeded) => {
      const found = existing.find((agent) => agent.slug === seeded.slug);
      const agentId =
        found?.id ??
        (
          await agents.create(principal, {
            instructions: AGENT_INSTRUCTIONS,
            model: AGENT_MODEL,
            name: seeded.name,
            runtime: AGENT_RUNTIME,
            slug: seeded.slug,
          })
        ).id;
      return { agentId, slug: seeded.slug };
    })
  );
};

/** The service has no Slack here, and the seed never asks it for any. */
const noSlack = (): never => {
  throw new LocalError("The seed has no Slack channels to read.");
};

/**
 * Repairs a Launch team that an older seed wrote with no folder: sets
 * `folder_path` and makes the folder entries. The `addMember` calls that follow
 * grant the agents their access, because they read the folder from the row.
 */
const giveFolder = async (
  db: Database,
  principal: Extract<Principal, { kind: "user" }>,
  teamId: string
): Promise<void> => {
  const folderPath = `teams/${TEAM_SLUG}`;
  const entries = ["teams", folderPath].map((path) =>
    db
      .insert(libraryEntries)
      .values({
        etag: null,
        kind: "dir",
        mtime: new Date().toISOString(),
        parent: path === "teams" ? "" : "teams",
        path,
        size: 0,
        updatedById: principal.userId,
        updatedByKind: "user",
        workspaceId: principal.workspaceId,
      })
      .onConflictDoNothing()
  );
  await sqliteAtomic(db)([
    db.update(teams).set({ folderPath }).where(eq(teams.id, teamId)),
    ...entries,
  ]);
};

/**
 * Makes the Launch team through the teams service, which gives it its
 * `teams/launch` folder and its agents' grants on it, or finds it by slug.
 * Then adds every member, which a rerun repairs without duplicating.
 */
const ensureTeam = async (
  db: Database,
  principal: Extract<Principal, { kind: "user" }>,
  agents: SlackRoomAgent[],
  leadAgentId: string,
  userId: string
): Promise<string> => {
  const service = createTeamsService({
    atomic: sqliteAtomic(db),
    clock: systemClock,
    db,
    slackChannels: {
      canPost: noSlack,
      list: noSlack,
      personChannels: noSlack,
    },
    slackStatus: noSlack,
  });
  const existing = (await service.list(principal)).find(
    (candidate) => candidate.slug === TEAM_SLUG
  );
  const team =
    existing ??
    (await service.create(principal, {
      leadAgentId,
      leadListens: true,
      name: TEAM_NAME,
      slug: TEAM_SLUG,
    }));
  if (existing && existing.folderPath === null) {
    await giveFolder(db, principal, existing.id);
  }
  const members = [
    ...agents.map((agent) => ({
      memberId: agent.agentId,
      memberKind: "agent" as const,
    })),
    { memberId: userId, memberKind: "user" as const },
  ];
  await Promise.all(
    members.map((member) =>
      service.addMember(principal, { ...member, teamId: team.id })
    )
  );
  return team.id;
};

/**
 * Seeds the Slack room for `clerkUserId` in `workspaceId`. Agents and the team
 * come first, through their services, then one atomic write holds the Slack
 * apps, the identity link and the removal of any channel link.
 */
export const seedSlackRoom = async ({
  clerkUserId,
  db,
  secretsKey,
  workspaceId,
}: SeedSlackRoomInput): Promise<SlackRoomSummary> => {
  // An admin, so a rerun for another Clerk user can still add members to the
  // team the first run made.
  const principal: Extract<Principal, { kind: "user" }> = {
    isAdmin: true,
    kind: "user",
    userId: clerkUserId,
    via: "session",
    workspaceId,
  };
  const agents = await ensureAgents(db, principal);
  const agentIdOf = (slug: string): string => {
    const agent = agents.find((candidate) => candidate.slug === slug);
    if (!agent) {
      throw new LocalError(`No agent ${slug} was made for the room.`);
    }
    return agent.agentId;
  };

  const key = await importSecretsKey(secretsKey);
  const appStatements = await Promise.all(
    SEEDED_AGENTS.map(({ app, slug }) =>
      installSlackAppStatements(db, key, workspaceId, agentIdOf(slug), app)
    )
  );
  const statements: Statement[] = appStatements.flat();

  const linkRows = await db
    .select({ id: identityLinks.id })
    .from(identityLinks)
    .where(
      and(
        eq(identityLinks.workspaceId, workspaceId),
        eq(identityLinks.provider, IDENTITY_PROVIDER),
        eq(identityLinks.teamId, SLACK_TEAM_ID),
        eq(identityLinks.externalUserId, DEV_SLACK_USER)
      )
    );
  const [link] = linkRows;
  statements.push(
    link
      ? db
          .update(identityLinks)
          .set({ clerkUserId })
          .where(eq(identityLinks.id, link.id))
      : db.insert(identityLinks).values({
          clerkUserId,
          createdAt: new Date().toISOString(),
          email: DEV_PERSON_EMAIL,
          externalUserId: DEV_SLACK_USER,
          id: crypto.randomUUID(),
          provider: IDENTITY_PROVIDER,
          teamId: SLACK_TEAM_ID,
          workspaceId,
        })
  );

  const teamId = await ensureTeam(
    db,
    principal,
    agents,
    agentIdOf(LEAD_SLUG),
    clerkUserId
  );
  statements.push(
    db.delete(teamSlackLinks).where(eq(teamSlackLinks.teamId, teamId))
  );

  await sqliteAtomic(db)(statements);
  return { agents, teamId };
};

const envFileValue = (contents: string, key: string): string | undefined => {
  const prefix = `${key}=`;
  const line = contents
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value : undefined;
};

/** A value from the environment, or else from `apps/web/.env.local`. */
export const readEnvValue = (key: string): string | undefined => {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!existsSync(ENV_FILE)) {
    return;
  }
  return envFileValue(readFileSync(ENV_FILE, "utf8"), key);
};

const clerkUserIdOf = (body: unknown): string | null => {
  if (!Array.isArray(body)) {
    return null;
  }
  const [first] = body;
  if (typeof first === "object" && first !== null && "id" in first) {
    return typeof first.id === "string" ? first.id : null;
  }
  return null;
};

/**
 * The id of the first Clerk user with `email`, from a read-only list call.
 * Returns null when no user has that address. Never creates or changes a user.
 */
export const clerkUserIdByEmail = async (
  email: string,
  secretKey: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> => {
  const url = new URL(CLERK_USERS_URL);
  url.searchParams.set("email_address", email);
  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) {
    throw new LocalError(
      `Clerk user lookup failed with HTTP ${response.status}. Check ${CLERK_SECRET_KEY}, or pass --clerk-user <id>.`
    );
  }
  return clerkUserIdOf(await response.json());
};

/**
 * The dev user's Clerk id: the `--clerk-user` value when given, else the user
 * whose email is `DEV_LOGIN_EMAIL`, looked up with `CLERK_SECRET_KEY`.
 */
export const resolveClerkUserId = async ({
  clerkUser,
  lookupClerkUser = clerkUserIdByEmail,
  readEnv = readEnvValue,
}: {
  clerkUser: string | undefined;
  lookupClerkUser?: (
    email: string,
    secretKey: string
  ) => Promise<string | null>;
  readEnv?: (key: string) => string | undefined;
}): Promise<string> => {
  if (clerkUser) {
    return clerkUser;
  }
  const email = readEnv(DEV_LOGIN_EMAIL_KEY);
  const secretKey = readEnv(CLERK_SECRET_KEY);
  if (!(email && secretKey)) {
    throw new LocalError(
      `Pass --clerk-user <id>, or set ${DEV_LOGIN_EMAIL_KEY} and ${CLERK_SECRET_KEY} in the environment or ${ENV_FILE}, so the dev user's Clerk id can be looked up.`
    );
  }
  const found = await lookupClerkUser(email, secretKey);
  if (!found) {
    throw new LocalError(
      `No Clerk user has the email in ${DEV_LOGIN_EMAIL_KEY}. Pass --clerk-user <id>, or run \`bun run create-dev-user\` in apps/web first.`
    );
  }
  return found;
};

export const main = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { "clerk-user": { type: "string" } },
  });
  const orgId = requireOrgId();
  const secretsKey = requireSecretsKey();
  const clerkUserId = await resolveClerkUserId({
    clerkUser: values["clerk-user"],
  });

  const local = openLocalDatabase();
  process.stderr.write(`Seeding ${local.file}.\n`);
  try {
    const principal = await devUserPrincipal(local.db, orgId);
    const summary = await seedSlackRoom({
      clerkUserId,
      db: local.db,
      secretsKey,
      workspaceId: principal.workspaceId,
    });
    process.stderr.write(
      `Seeded the Launch team ${summary.teamId} with ${summary.agents.length} agents.\n`
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    local.close();
  }
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
