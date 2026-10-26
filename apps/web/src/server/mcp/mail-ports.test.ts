import { expect, test } from "bun:test";
import { ToolError } from "@repo/mcp/result";
import { MailError } from "@repo/services/mail/types";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { createMailPorts } from "./mail-ports.ts";

const run: Principal = {
  agentId: "a",
  kind: "run",
  runId: "r",
  workspaceId: "w",
};
const draft = { cc: [], subject: "S", text: "T", to: ["x@example.net"] };

const portsOver = (mail: Record<string, unknown>) =>
  createMailPorts({
    principal: run,
    services: { mail } as unknown as Pick<Services, "mail">,
  });

test("a sent mail keeps its Message-ID and a held one drops the approval request", async () => {
  const ports = portsOver({
    reply: () =>
      Promise.resolve({
        message: "waiting for approval",
        messageId: "m2",
        requestId: "req",
        status: "held",
        threadId: "t",
      }),
    send: () =>
      Promise.resolve({
        messageId: "m1",
        rfcMessageId: "rfc",
        status: "sent",
        threadId: "t",
      }),
  });
  expect(await ports.send(draft)).toEqual({
    messageId: "m1",
    rfcMessageId: "rfc",
    status: "sent",
    threadId: "t",
  });
  expect(await ports.reply({ ...draft, threadId: "t" })).toEqual({
    messageId: "m2",
    status: "held",
    threadId: "t",
  });
});

test("list and read pass the run principal to the mail service", async () => {
  const seen: unknown[] = [];
  const ports = portsOver({
    agent: {
      listThreads: (principal: unknown, page: unknown) => {
        seen.push(principal, page);
        return Promise.resolve([]);
      },
      readThread: (principal: unknown, id: unknown) => {
        seen.push(principal, id);
        return Promise.resolve(null);
      },
    },
  });
  await ports.list({ limit: 5, page: 2 });
  await ports.read({ threadId: "t" });
  expect(seen).toEqual([run, { limit: 5, page: 2 }, run, "t"]);
});

test("mail failures become tool errors the agent can act on", async () => {
  const ports = portsOver({
    send: () => Promise.reject(new MailError("rate_limited", "Slow down")),
  });
  const error = await ports.send(draft).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe("conflict");
  expect((error as ToolError).message).toBe("Slow down");
});
