import type { Database } from "@repo/db";
import { a2aConnections } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import {
  agentConnectors,
  connectors,
  credentials,
} from "@repo/db/schema/connectors";
import { agentMailboxes } from "@repo/db/schema/mail";
import { agentSecrets, secrets } from "@repo/db/schema/secrets";
import { slackApps } from "@repo/db/schema/slack";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import type { AgentKeyApp, AgentKeys } from "@repo/db/shared";
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { decodeAllowedTools } from "./connectors/allowed-tools.ts";
import { ServiceError } from "./errors.ts";
import type { PeopleLookup } from "./events.ts";
import { effectiveOwner, readableWorkspace, requireUser } from "./guards.ts";
import type { Principal } from "./workspaces.ts";

const KEYS_READ = "keys.read";
const KEYS_KIND = "keys";

export const forAgentInputSchema = z.strictObject({
  agentId: z.string().min(1),
});

export const createKeysService = ({
  db,
  people,
}: {
  db: Database;
  people?: PeopleLookup;
}) => {
  const forAgent = async (
    principal: Principal,
    agentId: string
  ): Promise<AgentKeys> => {
    const workspaceId = readableWorkspace(principal, KEYS_READ);
    authorize(principal, KEYS_READ, {
      id: agentId,
      kind: KEYS_KIND,
      workspaceId,
    });
    // Like the profile read, Keys describes sign-ins for a calling person.
    const user = requireUser(principal, KEYS_READ);
    const [agentRow] = await db
      .select({
        askLevel: agents.askLevel,
        createdBy: agents.createdBy,
        handsTo: agents.handsTo,
        name: agents.name,
        ownerUserId: agents.ownerUserId,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)));
    const agent = agentRow
      ? {
          ...agentRow,
          handsTo: z.array(z.string()).parse(JSON.parse(agentRow.handsTo)),
        }
      : null;
    if (!agent || agent.status === "draft") {
      throw new ServiceError("not_found", "Agent not found");
    }
    const showOthers =
      user.isAdmin === true || effectiveOwner(agent) === user.userId;
    const [
      apps,
      secretRows,
      mailboxes,
      slack,
      connections,
      handoffs,
      overrides,
    ] = await Promise.all([
      db
        .select({
          allowedTools: agentConnectors.allowedTools,
          connectorId: connectors.id,
          connectorName: connectors.name,
          credentialMode: agentConnectors.credentialMode,
        })
        .from(agentConnectors)
        .innerJoin(
          connectors,
          and(
            eq(connectors.id, agentConnectors.connectorId),
            eq(connectors.workspaceId, workspaceId)
          )
        )
        .where(
          and(
            eq(agentConnectors.workspaceId, workspaceId),
            eq(agentConnectors.agentId, agentId)
          )
        )
        .orderBy(asc(connectors.name), asc(connectors.id)),
      db
        .select({ id: secrets.id, kind: secrets.mode, name: secrets.name })
        .from(agentSecrets)
        .innerJoin(
          secrets,
          and(
            eq(secrets.id, agentSecrets.secretId),
            eq(secrets.workspaceId, workspaceId)
          )
        )
        .where(
          and(
            eq(agentSecrets.workspaceId, workspaceId),
            eq(agentSecrets.agentId, agentId)
          )
        )
        .orderBy(asc(secrets.name), asc(secrets.id)),
      db
        .select({ address: agentMailboxes.address })
        .from(agentMailboxes)
        .where(
          and(
            eq(agentMailboxes.workspaceId, workspaceId),
            eq(agentMailboxes.agentId, agentId)
          )
        ),
      db
        .select({ status: slackApps.status })
        .from(slackApps)
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId),
            eq(slackApps.agentId, agentId),
            ne(slackApps.status, "revoked")
          )
        )
        .orderBy(asc(slackApps.createdAt), asc(slackApps.id)),
      db
        .select({
          connectionId: a2aConnections.id,
          peerKind: a2aConnections.peerKind,
          peerLabel: a2aConnections.peerLabel,
          slug: a2aConnections.slug,
          status: a2aConnections.status,
        })
        .from(a2aConnections)
        .where(
          and(
            eq(a2aConnections.workspaceId, workspaceId),
            eq(a2aConnections.localAgentId, agentId)
          )
        )
        .orderBy(asc(a2aConnections.slug), asc(a2aConnections.id)),
      agent.handsTo.length
        ? db
            .select({ agentId: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.workspaceId, workspaceId),
                inArray(agents.id, agent.handsTo),
                eq(agents.status, "active"),
                ne(agents.id, agentId)
              )
            )
        : Promise.resolve([]),
      db
        .select({ mode: agentToolRules.mode, toolKey: agentToolRules.toolKey })
        .from(agentToolRules)
        .where(
          and(
            eq(agentToolRules.workspaceId, workspaceId),
            eq(agentToolRules.agentId, agentId)
          )
        )
        .orderBy(asc(agentToolRules.toolKey)),
    ]);
    const signIns = apps.length
      ? await db
          .select({
            connectorId: credentials.connectorId,
            ownerId: credentials.ownerId,
            ownerKind: credentials.ownerKind,
            status: credentials.status,
          })
          .from(credentials)
          .where(
            and(
              eq(credentials.workspaceId, workspaceId),
              inArray(
                credentials.connectorId,
                apps.map((app) => app.connectorId)
              ),
              or(
                and(
                  eq(credentials.ownerKind, "agent"),
                  eq(credentials.ownerId, agentId)
                ),
                and(
                  eq(credentials.ownerKind, "user"),
                  showOthers ? undefined : eq(credentials.ownerId, user.userId)
                )
              )
            )
          )
          .orderBy(asc(credentials.ownerId))
      : [];
    const otherIds = showOthers
      ? [
          ...new Set(
            signIns
              .filter(
                (row) => row.ownerKind === "user" && row.ownerId !== user.userId
              )
              .map((row) => row.ownerId)
          ),
        ]
      : [];
    const names =
      people && otherIds.length
        ? await people(otherIds).catch(() => new Map())
        : new Map();
    const appRows: AgentKeyApp[] = apps.map((app) => {
      const owned = signIns.filter(
        (row) => row.connectorId === app.connectorId
      );
      const mine = owned.find(
        (row) => row.ownerKind === "user" && row.ownerId === user.userId
      );
      const agentCredential =
        app.credentialMode === "user"
          ? undefined
          : owned.find((credential) => credential.ownerKind === "agent");
      // user_or_agent uses the person for work on their behalf; it never falls
      // back to the agent when that person lacks a sign-in (credentials.resolve).
      const chosen =
        app.credentialMode === "agent"
          ? owned.find((row) => row.ownerKind === "agent")
          : mine;
      return {
        ...app,
        allowedTools: decodeAllowedTools(app.allowedTools),
        credentials: {
          agentSignIn: agentCredential
            ? { ownerName: agent.name, status: agentCredential.status }
            : null,
          hasOwnSignIn: mine !== undefined,
          otherSignIns: showOthers
            ? owned
                .filter(
                  (row) =>
                    row.ownerKind === "user" && row.ownerId !== user.userId
                )
                .map((row) => ({
                  ownerName: names.get(row.ownerId)?.name ?? "Someone",
                  status: row.status,
                }))
            : null,
        },
        signIn: chosen
          ? {
              ownerKind: chosen.ownerKind,
              ownerName: chosen.ownerKind === "agent" ? agent.name : "You",
              status: chosen.status,
            }
          : null,
      };
    });
    const byId = new Map(handoffs.map((row) => [row.agentId, row]));
    return {
      apps: appRows,
      asksBefore: { level: agent.askLevel, overrides },
      // The contract has one Slack state: use the first non-revoked app,
      // matching the profile. Mailbox addresses remain visible while provisioning.
      identity: {
        emailAddress: mailboxes[0]?.address ?? null,
        slackApp: slack[0]?.status ?? null,
      },
      otherAgents: {
        // Keep pending/revoked connections so their status explains availability;
        // a missing peer label uses our slug, never an untrusted peer card.
        connections: connections.map(({ peerLabel, slug, ...row }) => ({
          ...row,
          peerName: peerLabel ?? slug,
        })),
        handsTo: agent.handsTo.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        }),
      },
      secrets: secretRows,
    };
  };
  return { forAgent };
};

export type KeysService = ReturnType<typeof createKeysService>;
