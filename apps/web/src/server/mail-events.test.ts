import { expect, test } from "bun:test";
import { handleMailEvents, type QueuedEvent } from "./mail-events.ts";

const queued = (body: unknown) => {
  const calls = { ack: 0, retry: 0 };
  const event: QueuedEvent = {
    ack: () => {
      calls.ack += 1;
    },
    body,
    retry: () => {
      calls.retry += 1;
    },
  };
  return { calls, event };
};
const event = (type: string, payload: Record<string, unknown>) => ({
  payload: { messageId: "id-1", ...payload },
  type: `cf.email.sending.message.${type}`,
});

test("a bounced event records a bounce with the SMTP reason and acks", async () => {
  const { calls, event: item } = queued(
    event("bounced", { bounce: { reason: "550 5.1.1 User unknown" } })
  );
  const seen: unknown[] = [];
  await handleMailEvents([item], {
    record: (report) => {
      seen.push(report);
      return Promise.resolve();
    },
  });
  expect(seen).toEqual([
    { messageId: "id-1", reason: "550 5.1.1 User unknown", status: "bounced" },
  ]);
  expect(calls).toEqual({ ack: 1, retry: 0 });
});

test("failed and rejected events record a failure", async () => {
  const seen: unknown[] = [];
  await handleMailEvents(
    [
      queued(event("failed", { failure: { reason: "delivery_failed" } })).event,
      queued(
        event("rejected", {
          rejection: {
            detail: "Recipient is suppressed",
            reason: "suppressed",
          },
        })
      ).event,
    ],
    {
      record: (report) => {
        seen.push(report);
        return Promise.resolve();
      },
    }
  );
  expect(seen).toEqual([
    { messageId: "id-1", reason: "delivery_failed", status: "failed" },
    { messageId: "id-1", reason: "Recipient is suppressed", status: "failed" },
  ]);
});

test("other events and malformed bodies are acked and not recorded", async () => {
  const items = [
    queued(event("delivered", {})),
    queued(event("deferred", {})),
    queued({ payload: {}, type: "cf.email.sending.message.bounced" }),
    queued("nonsense"),
    queued(null),
  ];
  let recorded = 0;
  await handleMailEvents(
    items.map((i) => i.event),
    {
      record: () => {
        recorded += 1;
        return Promise.resolve();
      },
    }
  );
  expect(recorded).toBe(0);
  expect(items.every((i) => i.calls.ack === 1 && i.calls.retry === 0)).toBe(
    true
  );
});

test("a failing record retries that event and the rest still run", async () => {
  const first = queued(event("bounced", {}));
  const second = queued({
    ...event("bounced", {}),
    payload: { messageId: "id-2" },
  });
  await handleMailEvents([first.event, second.event], {
    record: (report) =>
      report.messageId === "id-1"
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(),
  });
  expect(first.calls).toEqual({ ack: 0, retry: 1 });
  expect(second.calls).toEqual({ ack: 1, retry: 0 });
});
