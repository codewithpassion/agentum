import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentMailboxes } from "@repo/db/schema/mail";
import { triggers } from "@repo/db/schema/triggers";
import { and, eq, isNull, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import {
  type EmailRoutingPort,
  type MailboxPort,
  RoutingNotConfiguredError,
} from "./types.ts";

type Mailbox = typeof agentMailboxes.$inferSelect;
const pending =
  "Provisioning pending: Cloudflare Email Routing is not configured yet";

const routingFailure = (
  error: unknown
): Pick<Mailbox, "status" | "lastError"> => {
  if (error instanceof RoutingNotConfiguredError) {
    return { lastError: pending, status: "provisioning" };
  }
  return {
    lastError: error instanceof Error ? error.message : String(error),
    status: "failed",
  };
};

/** Provisioning is the registry, rule and trigger. Option A's mailbox store starts on first use. */
export const createMailService = ({
  db,
  atomic,
  clock,
  events,
  mailbox,
  routing,
  domain,
}: {
  db: Database;
  atomic: Atomic;
  clock: Clock;
  events: EventsService;
  mailbox?: MailboxPort;
  routing?: EmailRoutingPort;
  domain?: string;
}) => {
  const findAgent = async (
    principal: Principal,
    agentId: string,
    internal = false
  ) => {
    if (
      principal.kind !== "user" &&
      !(internal && principal.kind === "system")
    ) {
      throw new ForbiddenError("mail.manage");
    }
    authorize(principal, "mail.manage", {
      kind: "mailbox",
      workspaceId: principal.kind === "user" ? principal.workspaceId : "system",
    });
    // Scope the lookup before reading another workspace's agent or mailbox.
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          principal.kind === "user"
            ? eq(agents.workspaceId, principal.workspaceId)
            : undefined
        )
      );
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    authorize(principal, "mail.manage", {
      kind: "mailbox",
      workspaceId: agent.workspaceId,
    });
    return agent;
  };
  const read = async (agentId: string): Promise<Mailbox | null> => {
    const [row] = await db
      .select()
      .from(agentMailboxes)
      .where(eq(agentMailboxes.agentId, agentId));
    return row ?? null;
  };
  const get = async (principal: Principal, agentId: string) => {
    await findAgent(principal, agentId);
    return await read(agentId);
  };
  const prepare = async (
    principal: Principal,
    agent: typeof agents.$inferSelect,
    row: Mailbox | null,
    address: string
  ) => {
    const agentId = agent.id;
    const id = row?.id ?? ulid();
    try {
      await atomic([
        row
          ? db
              .update(agentMailboxes)
              .set({
                address,
                lastError: null,
                routingRuleId:
                  row.address === address ? row.routingRuleId : null,
                status: "provisioning",
              })
              .where(eq(agentMailboxes.id, id))
          : db.insert(agentMailboxes).values({
              address,
              agentId,
              createdAt: clock.now().toISOString(),
              id,
              status: "provisioning",
              workspaceId: agent.workspaceId,
            }),
        // A stable id makes retries safe and preserves a person's trigger pause.
        db
          .insert(triggers)
          .values({
            agentId,
            createdAt: clock.now().toISOString(),
            createdBy: principal.kind === "user" ? principal.userId : "system",
            id: `mail:${id}`,
            kind: "mail",
            name: "Mail",
            workspaceId: agent.workspaceId,
          })
          .onConflictDoNothing(),
        // Provisioning a disabled mailbox again turns its mail trigger back on.
        ...(row?.status === "disabled"
          ? [
              db
                .update(triggers)
                .set({ disabledAt: null })
                .where(
                  and(eq(triggers.agentId, agentId), eq(triggers.kind, "mail"))
                ),
            ]
          : []),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // biome-ignore lint/style/useErrorCause: ServiceError has a fixed public constructor
        throw new ServiceError("conflict", "That address is taken");
      }
      throw error;
    }
    const prepared = await read(agentId);
    if (!prepared) {
      throw new ServiceError("not_found", "Mailbox not found");
    }
    return prepared;
  };
  const updateState = async (
    row: Mailbox,
    changes: Partial<Pick<Mailbox, "status" | "lastError" | "routingRuleId">>
  ): Promise<Mailbox> => {
    const [updated] = await db
      .update(agentMailboxes)
      .set(changes)
      .where(eq(agentMailboxes.id, row.id))
      .returning();
    if (!updated) {
      throw new ServiceError("not_found", "Mailbox not found");
    }
    return updated;
  };
  const record = async (
    principal: Principal,
    row: Mailbox,
    type: "mailbox.failed" | "mailbox.provisioned",
    payload: Record<string, string>
  ): Promise<void> => {
    await events.append({
      actor:
        principal.kind === "user"
          ? { id: principal.userId, kind: "user" }
          : { id: "mail", kind: "system" },
      agentId: row.agentId,
      payload: { address: row.address, ...payload },
      type,
      workspaceId: row.workspaceId,
    });
  };
  const route = async (
    principal: Principal,
    row: Mailbox,
    port: EmailRoutingPort
  ): Promise<Mailbox> => {
    let { routingRuleId } = row;
    try {
      if (!routingRuleId) {
        const existing = await port.findRule(row.address);
        if (existing) {
          throw new Error("Address in use outside Harbourmaster");
        }
        routingRuleId = (await port.createRule(row.address)).id;
      }
    } catch (error) {
      const failure = routingFailure(error);
      const failed = await updateState(row, failure);
      // A missing token is a wait, not a failure, so it logs nothing.
      if (failure.status === "failed") {
        await record(principal, failed, "mailbox.failed", {
          error: failure.lastError ?? "",
        });
      }
      return failed;
    }
    const active = await updateState(row, {
      lastError: null,
      routingRuleId,
      status: "active",
    });
    await record(principal, active, "mailbox.provisioned", {});
    return active;
  };
  const provision = async (
    principal: Principal,
    agentId: string
  ): Promise<Mailbox> => {
    const agent = await findAgent(principal, agentId, true);
    if (!(mailbox && routing && domain)) {
      throw new ServiceError("invalid", "Mail is not set up here");
    }
    if (agent.status !== "active" || !agent.emailLocal) {
      throw new ServiceError(
        "invalid",
        "Mail needs an active agent with a reserved address"
      );
    }
    const address = `${agent.emailLocal}@${domain.toLowerCase()}`;
    const row = await read(agentId);
    // An explicit provision can re-enable a disabled mailbox. The tick never selects disabled rows.
    if (row?.status === "active" && row.address === address) {
      return row;
    }
    const [owner] = await db
      .select({ agentId: agentMailboxes.agentId })
      .from(agentMailboxes)
      .where(eq(agentMailboxes.address, address));
    if (owner && owner.agentId !== agentId) {
      throw new ServiceError("conflict", "That address is taken");
    }
    if (row && row.address !== address && row.routingRuleId) {
      // Address reservations can change; remove only our previous rule and keep the mailbox/history id.
      try {
        await routing.deleteRule(row.routingRuleId);
      } catch (error) {
        return await updateState(row, routingFailure(error));
      }
    }
    return await route(
      principal,
      await prepare(principal, agent, row, address),
      routing
    );
  };
  const disable = async (principal: Principal, agentId: string) => {
    await findAgent(principal, agentId);
    const row = await read(agentId);
    if (!row) {
      throw new ServiceError("not_found", "Mailbox not found");
    }
    if (row.routingRuleId) {
      if (!routing) {
        throw new ServiceError("invalid", "Mail is not set up here");
      }
      await routing.deleteRule(row.routingRuleId);
    }
    await atomic([
      db
        .update(agentMailboxes)
        .set({ lastError: null, routingRuleId: null, status: "disabled" })
        .where(eq(agentMailboxes.id, row.id)),
      db
        .update(triggers)
        .set({ disabledAt: clock.now().toISOString() })
        .where(and(eq(triggers.agentId, agentId), eq(triggers.kind, "mail"))),
    ]);
    return {
      ...row,
      lastError: null,
      routingRuleId: null,
      status: "disabled" as const,
    };
  };
  const provisionPending = async (principal: Principal) => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("mail.provisionPending");
    }
    if (!(mailbox && routing && domain)) {
      return;
    }
    const rows = await db
      .select({ emailLocal: agents.emailLocal, id: agents.id })
      .from(agents)
      .leftJoin(agentMailboxes, eq(agentMailboxes.agentId, agents.id))
      .where(
        and(
          eq(agents.status, "active"),
          or(
            isNull(agentMailboxes.id),
            eq(agentMailboxes.status, "provisioning")
          )
        )
      );
    for (const row of rows) {
      if (row.emailLocal) {
        // biome-ignore lint/performance/noAwaitInLoops: avoid flooding the routing API on a healing tick
        await provision(principal, row.id);
      }
    }
  };
  events.onAppend(async (event) => {
    if (
      !(
        (event.type === "agent.created" ||
          event.type === "agent.address_reserved") &&
        event.agentId &&
        mailbox &&
        routing &&
        domain
      )
    ) {
      return;
    }
    const agent = await findAgent(SYSTEM_PRINCIPAL, event.agentId, true);
    if (
      agent.workspaceId === event.workspaceId &&
      agent.status === "active" &&
      agent.emailLocal
    ) {
      await provision(SYSTEM_PRINCIPAL, agent.id);
    }
  });
  return { disable, get, provision, provisionPending };
};
export type MailService = ReturnType<typeof createMailService>;
