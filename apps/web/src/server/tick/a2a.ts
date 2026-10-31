// Agent connection tick jobs for our side of a call: deliver due outbox rows
// (the activation, revoke and decline notices, and push notifications), settle
// approval cards, poll tasks we sent, wake agents whose answer arrived after
// their run ended, and end invites that ran out. Each job takes a bounded
// batch, so one tick stays short. Inbound tasks have their own sweep in
// `a2a-tasks.ts`, which already runs every minute.
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const a2aJobs: readonly TickJob[] = [
  {
    name: "a2a.outbox",
    run: ({ services }) => services.a2aOutbox.deliverDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "a2a.outbound-approvals",
    run: ({ services }) =>
      services.a2aOutbound.settleApprovals(SYSTEM_PRINCIPAL),
  },
  {
    name: "a2a.outbound-poll",
    run: ({ services }) => services.a2aOutbound.pollDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "a2a.outbound-wakes",
    run: ({ services }) => services.a2aOutbound.wakeDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "a2a.invites-expire",
    run: ({ services }) =>
      services.connections.expireStaleInvites(SYSTEM_PRINCIPAL),
  },
];
