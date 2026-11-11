import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FILE_CHUNK_BYTES } from "@repo/protocol/computer";
import {
  type ComputerFailureReason,
  type ComputerOutcome,
  type MachineRelayPort,
  noopRelay,
} from "@repo/services/machines/types";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import {
  createComputerPorts,
  takeDesktopScreenshot,
} from "./computer-ports.ts";

const run: Extract<Principal, { kind: "run" }> = {
  agentId: "agent-1",
  kind: "run",
  runId: "run-1",
  workspaceId: "ws-1",
};
const WORKDIR = "/srv/work";
const AGENT_DIR = `${WORKDIR}/agent-1`;

const ok = (result: object): Promise<ComputerOutcome> =>
  Promise.resolve({ ok: true, resultJson: JSON.stringify(result) });
const fail = (
  reason: ComputerFailureReason,
  code: string | null = null,
  message = "failed"
): Promise<ComputerOutcome> =>
  Promise.resolve({ code, message, ok: false, reason });
const notFound = (): Promise<ComputerOutcome> =>
  Promise.resolve({
    code: "not_found",
    message: "no such file",
    ok: false,
    reason: "client_error",
  });

/** A relay that reports a working directory, with each op overridden as needed. */
const relayWith = (
  overrides: Partial<MachineRelayPort> = {}
): MachineRelayPort => ({
  ...noopRelay,
  computerStatus: async (machineId) => ({
    ...(await noopRelay.computerStatus(machineId)),
    workdir: WORKDIR,
  }),
  ...overrides,
});

const harness = (relay: MachineRelayPort) => {
  const events: Record<string, unknown>[] = [];
  const services = {
    events: {
      append: (input: Record<string, unknown>) => {
        events.push(input);
        return Promise.resolve(undefined);
      },
    },
  } as unknown as Pick<Services, "events">;
  const ports = createComputerPorts({
    machineId: "m-1",
    principal: run,
    relay,
    services,
  });
  return { events, ports };
};

test("exec returns the exit code and output, and writes one event without the output", async () => {
  const calls: { cwd: string | null; command: string }[] = [];
  const { events, ports } = harness(
    relayWith({
      computerExec: (_machine, _principal, input) => {
        calls.push({ command: input.command, cwd: input.cwd });
        return ok({
          bytes_total: 18,
          duration_ms: 42,
          exit_code: 0,
          stderr: "",
          stdout: "secret-output-text",
          truncated: false,
        });
      },
    })
  );

  expect(await ports.exec({ command: "ls", timeout_ms: 1000 })).toEqual({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "secret-output-text",
  });
  expect(calls).toEqual([{ command: "ls", cwd: AGENT_DIR }]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actor: { id: "agent-1", kind: "agent" },
    agentId: "agent-1",
    payload: { command: "ls", durationMs: 42, exitCode: 0, machineId: "m-1" },
    runId: "run-1",
    type: "computer.exec",
    workspaceId: "ws-1",
  });
  expect(JSON.stringify(events)).not.toContain("secret-output-text");
});

test("exec on the offline noop relay reports offline", async () => {
  const { ports } = harness(noopRelay);
  expect(await ports.exec({ command: "ls", timeout_ms: 1000 })).toMatchObject({
    code: "offline",
    ok: false,
  });
});

test("exec with no working directory reports offline and runs nothing", async () => {
  let ran = false;
  const { events, ports } = harness({
    ...noopRelay,
    computerExec: () => {
      ran = true;
      return ok({});
    },
  });
  expect(await ports.exec({ command: "ls", timeout_ms: 1000 })).toEqual({
    code: "offline",
    ok: false,
    reason: "The computer has not reported its working directory yet.",
  });
  expect(ran).toBe(false);
  expect(events).toHaveLength(0);
});

test("a relay that drops the exec records the attempt with a null exit code", async () => {
  const { events, ports } = harness(
    relayWith({
      computerExec: () => fail("offline", null, "The computer is gone."),
    })
  );
  expect(await ports.exec({ command: "ls", timeout_ms: 1000 })).toEqual({
    code: "offline",
    ok: false,
    reason: "The computer is gone.",
  });
  expect(events[0]).toMatchObject({
    payload: { exitCode: null },
    type: "computer.exec",
  });
});

test("an agent id that cannot name a directory is refused", async () => {
  const ports = createComputerPorts({
    machineId: "m-1",
    principal: { ...run, agentId: "../etc" },
    relay: relayWith(),
    services: {
      events: { append: () => Promise.resolve(undefined) },
    } as unknown as Pick<Services, "events">,
  });
  expect(await ports.listDir({ path: "/" })).toMatchObject({
    code: "validation",
    ok: false,
  });
});

test("readFile returns the content and size, and writes a get event", async () => {
  const { events, ports } = harness(
    relayWith({
      fileGet: (_machine, _principal, input) => {
        expect(input.path).toBe(`${AGENT_DIR}/notes/a.txt`);
        return ok({
          data_b64: btoa("hello"),
          eof: true,
          sha256: null,
          size: 5,
        });
      },
    })
  );

  expect(
    await ports.readFile({ maxBytes: 1000, path: "/notes/a.txt" })
  ).toEqual({ content: "hello", ok: true, size: 5 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    payload: { bytes: 5, machineId: "m-1", op: "get", path: "/notes/a.txt" },
    type: "computer.file",
  });
});

test("readFile reads every chunk until eof", async () => {
  const first = "a".repeat(FILE_CHUNK_BYTES);
  const second = "tail";
  const offsets: number[] = [];
  const { ports } = harness(
    relayWith({
      fileGet: (_machine, _principal, input) => {
        offsets.push(input.offset);
        const chunk = input.offset === 0 ? first : second;
        return ok({
          data_b64: btoa(chunk),
          eof: input.offset !== 0,
          sha256: null,
          size: first.length + second.length,
        });
      },
    })
  );

  const result = await ports.readFile({ maxBytes: 10_000_000, path: "/a" });
  expect(offsets).toEqual([0, FILE_CHUNK_BYTES]);
  expect(result).toEqual({
    content: first + second,
    ok: true,
    size: first.length + second.length,
  });
});

test("readFile of a file over maxBytes returns no content and the real size", async () => {
  const reads: number[] = [];
  const { ports } = harness(
    relayWith({
      fileGet: (_machine, _principal, input) => {
        reads.push(input.offset);
        return ok({
          data_b64: btoa("0123456789"),
          eof: false,
          sha256: null,
          size: 5000,
        });
      },
    })
  );
  expect(await ports.readFile({ maxBytes: 100, path: "/big" })).toEqual({
    content: "",
    ok: true,
    size: 5000,
  });
  expect(reads).toEqual([0]);
});

test("readFile of a missing file reports not_found", async () => {
  const { events, ports } = harness(relayWith({ fileGet: () => notFound() }));
  expect(
    await ports.readFile({ maxBytes: 1000, path: "/missing.txt" })
  ).toEqual({ code: "not_found", ok: false, reason: "no such file" });
  expect(events).toHaveLength(0);
});

test("writeFile splits a large file into chunks, digests only the final one, and reports created", async () => {
  const content = "x".repeat(FILE_CHUNK_BYTES * 2 + 10);
  const puts: {
    data_b64: string;
    final: boolean;
    path: string;
    seq: number;
    sha256: string | null;
    transfer_id: string;
  }[] = [];
  const { events, ports } = harness(
    relayWith({
      fileGet: () => notFound(),
      filePut: (_machine, _principal, input) => {
        puts.push(input);
        return ok({ bytes_written: 0, sha256: null });
      },
    })
  );

  expect(await ports.writeFile({ content, path: "/out/big.txt" })).toEqual({
    created: true,
    ok: true,
    size: content.length,
  });
  expect(puts.map((put) => put.seq)).toEqual([0, 1, 2]);
  expect(puts.map((put) => put.final)).toEqual([false, false, true]);
  expect(puts.map((put) => put.sha256 === null)).toEqual([true, true, false]);
  expect(puts[2]?.sha256).toBe(
    createHash("sha256").update(content).digest("hex")
  );
  expect(new Set(puts.map((put) => put.transfer_id)).size).toBe(1);
  expect(puts.every((put) => put.path === `${AGENT_DIR}/out/big.txt`)).toBe(
    true
  );
  expect(
    Buffer.concat(
      puts.map((put) => Buffer.from(put.data_b64, "base64"))
    ).toString()
  ).toBe(content);
  expect(events[0]).toMatchObject({
    payload: { bytes: content.length, op: "put", path: "/out/big.txt" },
    type: "computer.file",
  });
});

test("writeFile reports created false when the file already exists", async () => {
  const { ports } = harness(
    relayWith({
      fileGet: () => ok({ data_b64: "", eof: true, sha256: null, size: 0 }),
      filePut: () => ok({ bytes_written: 2, sha256: "h" }),
    })
  );
  expect(await ports.writeFile({ content: "hi", path: "/a.txt" })).toEqual({
    created: false,
    ok: true,
    size: 2,
  });
});

test("listDir parses the listing script output", async () => {
  const commands: { command: string; cwd: string | null }[] = [];
  const { events, ports } = harness(
    relayWith({
      computerExec: (_machine, _principal, input) => {
        commands.push({ command: input.command, cwd: input.cwd });
        return ok({
          bytes_total: 0,
          duration_ms: 1,
          exit_code: 0,
          stderr: "",
          stdout: "d 0 sub\0f 5 a b.txt\0",
          truncated: false,
        });
      },
    })
  );
  expect(await ports.listDir({ path: "/" })).toEqual({
    entries: [
      { directory: true, name: "sub", size: 0 },
      { directory: false, name: "a b.txt", size: 5 },
    ],
    ok: true,
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]?.cwd).toBeNull();
  expect(commands[0]?.command).toContain(`'${AGENT_DIR}'`);
  expect(events).toHaveLength(0);
});

test("listDir with a nonzero exit reports conflict with stderr", async () => {
  const { ports } = harness(
    relayWith({
      computerExec: () =>
        ok({
          bytes_total: 0,
          duration_ms: 1,
          exit_code: 1,
          stderr: "cd: permission denied\n",
          stdout: "",
          truncated: false,
        }),
    })
  );
  expect(await ports.listDir({ path: "/" })).toEqual({
    code: "conflict",
    ok: false,
    reason: "cd: permission denied",
  });
});

test("desktopInput passes an ok reply through as applied actions", async () => {
  const { ports } = harness(
    relayWith({
      desktopInput: () => ok({ ok: true }),
    })
  );
  expect(
    await ports.desktopInput({
      actions: [{ text: "hi", type: "type" }],
    })
  ).toEqual({ applied: 1, ok: true });
});

test("desktopInput passes desktop_unavailable and human_in_control through", async () => {
  const unavailable = harness(
    relayWith({
      desktopInput: () =>
        fail("desktop_unavailable", null, "The desktop is off."),
    })
  );
  expect(
    await unavailable.ports.desktopInput({
      actions: [{ text: "hi", type: "type" }],
    })
  ).toEqual({
    code: "desktop_unavailable",
    ok: false,
    reason: "The desktop is off.",
  });

  const held = harness(
    relayWith({
      desktopInput: () =>
        fail("human_in_control", null, "A person has the desktop."),
    })
  );
  expect(
    await held.ports.desktopInput({
      actions: [{ text: "hi", type: "type" }],
    })
  ).toEqual({
    code: "human_in_control",
    ok: false,
    reason: "A person has the desktop.",
  });
});

test("desktopSnapshot sends the request as an app op and reads the tree", async () => {
  const sent: unknown[] = [];
  const { ports } = harness(
    relayWith({
      desktopApp: (_machineId, principal, input) => {
        sent.push({ input, principal });
        return ok({
          complete: true,
          ref_count: 4,
          snapshot_id: "sabc",
          text: '{"ok":true}',
        });
      },
    })
  );
  expect(
    await ports.desktopSnapshot({
      app: "chromium",
      compact: true,
      interactive: true,
      root: null,
      skeleton: false,
    })
  ).toEqual({
    complete: true,
    ok: true,
    refCount: 4,
    snapshotId: "sabc",
    text: '{"ok":true}',
  });
  expect(sent).toEqual([
    {
      input: {
        app: "chromium",
        compact: true,
        interactive: true,
        op: "desktop_snapshot",
        root: null,
        skeleton: false,
      },
      principal: { agentId: "agent-1", kind: "agent" },
    },
  ]);
});

test("desktopAct and desktopApps read their replies, and a machine refusal is a validation failure", async () => {
  const { ports } = harness(
    relayWith({
      desktopApp: (_machineId, _principal, input) =>
        input.op === "desktop_apps"
          ? ok({ apps: [{ name: "chromium" }] })
          : ok({ app: "chromium", ok: true, text: "{}" }),
    })
  );
  expect(await ports.desktopApps()).toEqual({ apps: ["chromium"], ok: true });
  expect(
    await ports.desktopAct({
      action: "click",
      headed: false,
      ref: "@sabc:e1",
      text: null,
    })
  ).toEqual({ app: "chromium", ok: true, text: "{}" });
  const refused = harness(
    relayWith({
      desktopApp: () =>
        fail("client_error", "denied", "this computer refuses physical input"),
    })
  );
  expect(
    await refused.ports.desktopAct({
      action: "click",
      headed: true,
      ref: "@sabc:e1",
      text: null,
    })
  ).toEqual({
    code: "validation",
    ok: false,
    reason: "this computer refuses physical input",
  });
  const garbled = harness(
    relayWith({ desktopApp: () => ok({ nonsense: true }) })
  );
  expect((await garbled.ports.desktopApps()).ok).toBe(false);
});

test("screenshot returns the image", async () => {
  const { ports } = harness(
    relayWith({
      desktopScreenshot: () =>
        ok({
          data_b64: "QUJD",
          height: 800,
          media_type: "image/jpeg",
          width: 1280,
        }),
    })
  );
  expect(await ports.screenshot()).toEqual({
    image: { data: "QUJD", mimeType: "image/jpeg" },
    ok: true,
  });
});

test("takeDesktopScreenshot returns the image of the desktop", async () => {
  const relay = relayWith({
    desktopScreenshot: () =>
      ok({
        data_b64: "QUJD",
        height: 800,
        media_type: "image/jpeg",
        width: 1280,
      }),
  });
  expect(await takeDesktopScreenshot(relay, "m-1", { kind: "agent" })).toEqual({
    image: { data: "QUJD", mimeType: "image/jpeg" },
    ok: true,
  });
});

test("takeDesktopScreenshot reports a human in control as human_in_control", async () => {
  const relay = relayWith({
    desktopScreenshot: () =>
      fail("human_in_control", null, "A person has the desktop."),
  });
  expect(await takeDesktopScreenshot(relay, "m-1", { kind: "agent" })).toEqual({
    code: "human_in_control",
    ok: false,
    reason: "A person has the desktop.",
  });
});

test("takeDesktopScreenshot on an offline computer reports offline", async () => {
  expect(
    await takeDesktopScreenshot(noopRelay, "m-1", { kind: "agent" })
  ).toMatchObject({ code: "offline", ok: false });
});

test("a reply the server cannot parse is a conflict", async () => {
  const { ports } = harness(
    relayWith({
      fileGet: () => Promise.resolve({ ok: true, resultJson: "{}" }),
    })
  );
  expect(await ports.readFile({ maxBytes: 100, path: "/a" })).toMatchObject({
    code: "conflict",
    ok: false,
  });
});
