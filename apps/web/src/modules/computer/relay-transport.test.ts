import { describe, expect, mock, test } from "bun:test";

/**
 * The hop from the computer client into the relay. It carries no logic of its
 * own, so the one thing worth pinning is the error type: the relay's reason -
 * "the host is offline, start the container" - has to arrive as a
 * `ComputerTransportError`, because that is what `remote-client.ts` shows the
 * agent verbatim rather than replacing with a generic failure.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createRelayTransport } = await import("./relay-transport");
const { ComputerTransportError } = await import("./remote-client");

const okOutcome = {
  code: null,
  message: "",
  ok: true,
  reason: null,
  result_json: '{"ok":true}',
};

const envFor = (relay: {
  request: (message: Record<string, unknown>) => Promise<unknown>;
}) => {
  const addressed: string[] = [];
  const env = {
    COMPUTER_RELAY: {
      get: () => relay,
      idFromName: (name: string) => {
        addressed.push(name);
        return name;
      },
    },
  } as unknown as Env;
  return { addressed, env };
};

describe("createRelayTransport", () => {
  test("sends the message to the host's own relay and returns its reply", async () => {
    const sent: Record<string, unknown>[] = [];
    const { addressed, env } = envFor({
      request: (message) => {
        sent.push(message);
        return Promise.resolve(okOutcome);
      },
    });

    const reply = await createRelayTransport(env, "host-1").send({
      id: "req-1",
      op: "ping",
    });

    expect(addressed).toEqual(["host-1"]);
    expect(sent).toEqual([{ id: "req-1", op: "ping" }]);
    expect(reply).toEqual({ id: "req-1", result: { ok: true } });
  });

  test("a daemon error reaches the caller with its code", async () => {
    const { env } = envFor({
      request: () =>
        Promise.resolve({
          code: "not_found",
          message: "no such file: /x",
          ok: false,
          reason: "client_error",
          result_json: null,
        }),
    });

    expect(
      await createRelayTransport(env, "host-1").send({
        id: "r",
        op: "file_get",
      })
    ).toEqual({
      error: { code: "not_found", message: "no such file: /x" },
      id: "r",
    });
  });

  test("keeps the relay's reason, as the failure the agent is shown", async () => {
    const reason =
      'The computer host "office-box" is offline (12 minutes ago). Start the container and try again.';
    const { env } = envFor({
      request: () => Promise.reject(new Error(reason)),
    });

    const failure = createRelayTransport(env, "host-1").send({ op: "ping" });

    await expect(failure).rejects.toBeInstanceOf(ComputerTransportError);
    await expect(failure).rejects.toThrow(reason);
  });
});
