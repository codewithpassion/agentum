import { expect, test } from "bun:test";
import { RoutingNotConfiguredError } from "@repo/services/mail/types";
import { type MailEnv, mailInfra, mailRouting } from "./mail-infra.ts";
import type { MailboxDO } from "./mailbox.ts";

const env = (overrides: Partial<MailEnv> = {}): MailEnv => ({
  EMAIL: { send: () => Promise.resolve({ messageId: "x" }) },
  FILES: {} as R2Bucket,
  MAILBOX: {} as DurableObjectNamespace<MailboxDO>,
  ...overrides,
});

test("an empty MAIL_DOMAIN turns mail off", () => {
  expect(mailInfra(env({ MAIL_DOMAIN: "" }))).toEqual({});
  expect(mailInfra(env())).toEqual({});
});

test("a MAIL_DOMAIN builds the port, the routing adapter and the lowercase domain", () => {
  const infra = mailInfra(env({ MAIL_DOMAIN: " RockyShoresLabs.io " }));
  expect(infra.mailDomain).toBe("rockyshoreslabs.io");
  expect(infra.mailbox).toBeDefined();
  expect(infra.mailRouting).toBeDefined();
});

test("without the token every routing call says provisioning is pending", async () => {
  const routing = mailRouting(
    env({ MAIL_WORKER_NAME: "w", MAIL_ZONE_ID: "z" })
  );
  await expect(routing.findRule("a@example.com")).rejects.toBeInstanceOf(
    RoutingNotConfiguredError
  );
  await expect(routing.createRule("a@example.com")).rejects.toBeInstanceOf(
    RoutingNotConfiguredError
  );
});
