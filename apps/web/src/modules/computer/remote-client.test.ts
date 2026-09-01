import { beforeEach, describe, expect, test } from "bun:test";
import {
  ComputerTransportError,
  createRemoteBackend,
  ping,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  type Transport,
} from "./remote-client";

/**
 * The remote backend against a fake daemon. Nothing here touches a network:
 * the transport is the seam, and these are the checks that stop a daemon - or
 * anything pretending to be one - from feeding the tools a shape they would
 * pass on as a success.
 */

const sent: Record<string, unknown>[] = [];

/** Answers every request with `result`, in the `{ id, result }` envelope. */
const replying = (result: unknown): Transport => ({
  send: (message) => {
    sent.push(message);
    return Promise.resolve({ id: message.id, result });
  },
});

/** Answers with something that is not the envelope at all. */
const replyingRaw = (reply: unknown): Transport => ({
  send: () => Promise.resolve(reply),
});

const throwing = (error: unknown): Transport => ({
  send: () => Promise.reject(error),
});

const lastSent = () => sent.at(-1) as Record<string, unknown>;

beforeEach(() => {
  sent.length = 0;
});

describe("the protocol", () => {
  test("read sends the op, the path and the byte cap", async () => {
    const backend = createRemoteBackend(
      replying({ content: "hello", ok: true, size: 5 })
    );

    const result = await backend.readFile("/notes/plan.md", 1000);

    expect(result).toEqual({ content: "hello", ok: true, size: 5 });
    expect(lastSent().op).toBe("read");
    expect(lastSent().path).toBe("/notes/plan.md");
    expect(lastSent().maxBytes).toBe(1000);
    expect(typeof lastSent().id).toBe("string");
  });

  test("write sends the content and reports what was created", async () => {
    const backend = createRemoteBackend(
      replying({ created: true, ok: true, size: 3 })
    );

    const result = await backend.writeFile("/a.txt", "abc");

    expect(result).toEqual({ created: true, ok: true, size: 3 });
    expect(lastSent().op).toBe("write");
    expect(lastSent().content).toBe("abc");
  });

  test("an upload's bytes travel as base64, not as JSON digits", async () => {
    const backend = createRemoteBackend(
      replying({ created: true, ok: true, size: 4 })
    );

    const result = await backend.writeFileBytes(
      "/uploads/logo.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    );

    expect(result).toEqual({ created: true, ok: true, size: 4 });
    expect(lastSent().op).toBe("write");
    expect(lastSent().encoding).toBe("base64");
    expect(lastSent().content).toBe("iVBORw==");
  });

  test("a file bigger than one base64 chunk still encodes whole", async () => {
    const backend = createRemoteBackend(
      replying({ created: true, ok: true, size: 20_000 })
    );
    const bytes = new Uint8Array(20_000).fill(0x41);

    await backend.writeFileBytes("/uploads/big.bin", bytes);

    const content = lastSent().content as string;
    expect(atob(content).length).toBe(20_000);
  });

  test("edit sends both strings", async () => {
    const backend = createRemoteBackend(
      replying({ created: false, ok: true, size: 9 })
    );

    const result = await backend.editFile("/a.txt", "old", "new");

    expect(result).toEqual({ created: false, ok: true, size: 9 });
    expect(lastSent().op).toBe("edit");
    expect(lastSent().oldString).toBe("old");
    expect(lastSent().newString).toBe("new");
  });

  test("list returns the entries, defaulting what the daemon left out", async () => {
    const backend = createRemoteBackend(
      replying({
        entries: [
          { directory: true, name: "notes", size: 0 },
          { name: "a.txt" },
        ],
        ok: true,
      })
    );

    const result = await backend.listDir("/");

    expect(result).toEqual({
      entries: [
        { directory: true, name: "notes", size: 0 },
        { directory: false, name: "a.txt", size: 0 },
      ],
      ok: true,
    });
    expect(lastSent().op).toBe("list");
  });

  test("exec sends the command and a default timeout", async () => {
    const backend = createRemoteBackend(
      replying({ exitCode: 0, ok: true, stderr: "", stdout: "hi" })
    );

    const result = await backend.exec("echo hi");

    expect(result).toEqual({ exitCode: 0, ok: true, stderr: "", stdout: "hi" });
    expect(lastSent().op).toBe("exec");
    expect(lastSent().command).toBe("echo hi");
    expect(lastSent().timeoutMs).toBe(30_000);
  });

  test("exec caps the timeout at ten minutes", async () => {
    const backend = createRemoteBackend(
      replying({ exitCode: 0, ok: true, stderr: "", stdout: "" })
    );

    await backend.exec("sleep 1", REMOTE_EXEC_MAX_TIMEOUT_MS * 10);

    expect(lastSent().timeoutMs).toBe(REMOTE_EXEC_MAX_TIMEOUT_MS);
  });

  test("a refusal from the daemon keeps its own reason", async () => {
    const backend = createRemoteBackend(
      replying({ ok: false, reason: "No such file: /nope" })
    );

    expect(await backend.readFile("/nope", 10)).toEqual({
      ok: false,
      reason: "No such file: /nope",
    });
  });

  test("ping reports the daemon's version and hostname", async () => {
    const result = await ping(
      replying({
        hostname: "office-box",
        ok: true,
        uptimeMs: 12,
        version: "1.2.3",
      })
    );

    expect(result).toEqual({
      hostname: "office-box",
      ok: true,
      uptimeMs: 12,
      version: "1.2.3",
    });
  });
});

/** The refusal reason, or the empty string when the call wrongly succeeded. */
const reasonOf = (result: { ok: boolean; reason?: string }): string =>
  result.ok ? "" : (result.reason ?? "");

describe("replies that cannot be trusted", () => {
  test("a success missing its payload is not a success", async () => {
    const backend = createRemoteBackend(replying({ ok: true }));

    expect(reasonOf(await backend.readFile("/a.txt", 10))).toContain(
      "could not understand"
    );
  });

  test("a result with no ok at all is refused", async () => {
    const backend = createRemoteBackend(replying({ size: 3 }));

    expect(reasonOf(await backend.writeFile("/a.txt", "abc"))).toContain(
      "could not understand"
    );
  });

  test("an entry without a name poisons the whole listing", async () => {
    const backend = createRemoteBackend(
      replying({ entries: [{ name: "a" }, { size: 1 }], ok: true })
    );

    expect(reasonOf(await backend.listDir("/"))).toContain(
      "could not understand"
    );
  });

  test("an exec with no exit code is refused", async () => {
    const backend = createRemoteBackend(replying({ ok: true, stdout: "done" }));

    expect(reasonOf(await backend.exec("true"))).toContain(
      "could not understand"
    );
  });

  test("a reply outside the envelope is refused", async () => {
    const backend = createRemoteBackend(replyingRaw({ ok: true, size: 1 }));

    expect(reasonOf(await backend.writeFile("/a.txt", "a"))).toContain(
      "could not understand"
    );
  });

  test("a reply for another request is discarded, not used", async () => {
    const backend = createRemoteBackend(
      replyingRaw({
        id: "some-other-call",
        result: { content: "x", ok: true, size: 1 },
      })
    );

    expect(reasonOf(await backend.readFile("/a.txt", 10))).toContain(
      "could not understand"
    );
  });

  test("a ping that answers with nonsense is not a healthy host", async () => {
    expect(reasonOf(await ping(replyingRaw("pong")))).toContain(
      "could not understand"
    );
  });
});

describe("a transport that fails", () => {
  test("passes through a reason the transport wrote for a person", async () => {
    const offline =
      "The computer host `office-box` is offline (last seen 12 minutes ago). Start the container and try again.";
    const backend = createRemoteBackend(
      throwing(new ComputerTransportError(offline))
    );

    expect(await backend.exec("ls")).toEqual({ ok: false, reason: offline });
  });

  test("turns anything else into a reason, never a stack trace", async () => {
    const backend = createRemoteBackend(
      throwing(new TypeError("fetch failed: ECONNREFUSED 10.0.0.4:443"))
    );

    const result = await backend.readFile("/a.txt", 10);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      "could not be reached"
    );
    expect(result.ok === false && result.reason).not.toContain("ECONNREFUSED");
  });

  test("reports the failure on ping too, rather than throwing", async () => {
    const result = await ping(throwing(new Error("boom")));

    expect(result.ok).toBe(false);
  });
});
