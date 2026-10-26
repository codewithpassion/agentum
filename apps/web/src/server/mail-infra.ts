// The mail adapters of the composition root: the mailbox port over one Durable
// Object per mailbox, the `FILES` bucket and the `send_email` binding, and the
// Email Routing rules adapter. Kept free of `cloudflare:workers` imports so bun
// can test it.
import { createMailboxPort, type MailboxClient } from "@repo/mailbox/port";
import type { EmailRoutingPort, MailboxPort } from "@repo/services/mail/types";
import type { Infra } from "./compose.ts";
import { createEmailRoutingPort } from "./email-routing.ts";
import type { MailboxDO } from "./mailbox.ts";
import { r2FileBlobs } from "./r2-files.ts";

/** The bindings and vars the mail adapters read. */
export interface MailEnv {
  CF_EMAIL_ROUTING_TOKEN?: string;
  EMAIL: SendEmail;
  FILES: R2Bucket;
  MAIL_DOMAIN?: string;
  MAIL_WORKER_NAME?: string;
  MAIL_ZONE_ID?: string;
  MAILBOX: DurableObjectNamespace<MailboxDO>;
}

/** One mailbox's Durable Object as the port's client, by mailbox row id. */
export const durableMailbox =
  (namespace: DurableObjectNamespace<MailboxDO>) =>
  (mailboxId: string): MailboxClient =>
    namespace.get(namespace.idFromName(mailboxId));

/** The mailbox port over the Durable Objects, R2 and the send binding. */
export const mailboxPort = (env: MailEnv): MailboxPort =>
  createMailboxPort({
    files: r2FileBlobs(env.FILES),
    mailbox: durableMailbox(env.MAILBOX),
    sender: env.EMAIL,
  });

/** The routing adapter. Without the token it throws `RoutingNotConfiguredError`, so mailboxes wait. */
export const mailRouting = (env: MailEnv): EmailRoutingPort =>
  createEmailRoutingPort({
    token: env.CF_EMAIL_ROUTING_TOKEN,
    workerName: env.MAIL_WORKER_NAME,
    zoneId: env.MAIL_ZONE_ID,
  });

/** The mail infra, or nothing when `MAIL_DOMAIN` is empty (mail is off, as in previews). */
export const mailInfra = (
  env: MailEnv
): Pick<Infra, "mailbox" | "mailDomain" | "mailRouting"> => {
  const domain = env.MAIL_DOMAIN?.trim().toLowerCase();
  if (!domain) {
    return {};
  }
  return {
    mailbox: mailboxPort(env),
    mailDomain: domain,
    mailRouting: mailRouting(env),
  };
};
