import { describe, expect, test } from "bun:test";

const {
  ComputerTransportError,
  createRemoteBackend,
  ping,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
} = await import("./remote-client");
const { FILE_CHUNK_BYTES } = await import("./protocol");

type Message = Record<string, unknown>;
type Handler = (message: Message) => unknown;

/**
 * A transport that answers each message with what `handler` returns for it. A
 * handler may return an `{ error }` envelope to model a daemon error, or throw
 * to model the connection failing.
 */
const fakeTransport = (handler: Handler) => {
  const sent: Message[] = [];
  return {
    sent,
    transport: {
      send: (message: Message) => {
        sent.push(message);
        return Promise.resolve(handler(message));
      },
    },
  };
};

const reply = (message: Message, result: Record<string, unknown>) => ({
  id: message.id,
  result,
});

const ROOT = "/var/lib/agentum-computer/sessions/agent-1";
const root = () => Promise.resolve({ ok: true as const, path: ROOT });

const execOk = (stdout = "") => ({
  bytes_total: stdout.length,
  duration_ms: 1,
  exit_code: 0,
  stderr: "",
  stdout,
  truncated: false,
});

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const base64Of = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

describe("exec", () => {
  test("runs in the agent's directory with the timeout capped", async () => {
    const { sent, transport } = fakeTransport((message) =>
      reply(message, execOk("hi\n"))
    );
    const backend = createRemoteBackend(transport, root);

    const result = await backend.exec(
      "echo hi",
      REMOTE_EXEC_MAX_TIMEOUT_MS * 5
    );

    expect(result).toEqual({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "hi\n",
    });
    expect(sent[0]).toMatchObject({
      command: "echo hi",
      cwd: ROOT,
      env: {},
      op: "exec",
      timeout_ms: REMOTE_EXEC_MAX_TIMEOUT_MS,
    });
  });

  test("a timed-out command is cancelled by the id it was sent with", async () => {
    const { sent, transport } = fakeTransport((message) => {
      if (message.op === "exec") {
        throw new ComputerTransportError(
          "The computer did not answer in time.",
          {
            timedOut: true,
          }
        );
      }
      return reply(message, { cancelled: true });
    });
    const backend = createRemoteBackend(transport, root);

    const result = await backend.exec("sleep 99", 1000);

    expect(result.ok).toBe(false);
    expect(sent.map((message) => message.op)).toEqual(["exec", "cancel"]);
    expect(sent[1]?.target_id).toBe(sent[0]?.id);
  });

  test("a command that fails for another reason is not cancelled", async () => {
    const { sent, transport } = fakeTransport(() => {
      throw new ComputerTransportError("The computer is offline.");
    });
    const backend = createRemoteBackend(transport, root);

    const result = await backend.exec("ls");

    expect(result).toEqual({ ok: false, reason: "The computer is offline." });
    expect(sent.map((message) => message.op)).toEqual(["exec"]);
  });

  test("a host whose root is unknown runs nothing", async () => {
    const { sent, transport } = fakeTransport(() => ({}));
    const backend = createRemoteBackend(transport, () =>
      Promise.resolve({ ok: false, reason: "No working directory yet." })
    );

    expect(await backend.exec("ls")).toEqual({
      ok: false,
      reason: "No working directory yet.",
    });
    expect(sent).toEqual([]);
  });
});

describe("file_get", () => {
  test("reads a file across chunks until eof", async () => {
    const first = new Uint8Array(FILE_CHUNK_BYTES).fill(97);
    const second = new TextEncoder().encode("tail");
    const { sent, transport } = fakeTransport((message) => {
      const { offset } = message;
      if (offset === 0) {
        return reply(message, {
          data_b64: base64Of(first),
          eof: false,
          sha256: null,
          size: FILE_CHUNK_BYTES + second.length,
        });
      }
      return reply(message, {
        data_b64: base64Of(second),
        eof: true,
        sha256: null,
        size: FILE_CHUNK_BYTES + second.length,
      });
    });
    const backend = createRemoteBackend(transport, root);

    const result = await backend.readFile("/notes.txt", 1_000_000);

    expect(result).toEqual({
      content: `${"a".repeat(FILE_CHUNK_BYTES)}tail`,
      ok: true,
      size: FILE_CHUNK_BYTES + second.length,
    });
    expect(sent.map((message) => message.offset)).toEqual([
      0,
      FILE_CHUNK_BYTES,
    ]);
    expect(sent[0]).toMatchObject({
      max_bytes: FILE_CHUNK_BYTES,
      op: "file_get",
      path: `${ROOT}/notes.txt`,
    });
  });

  test("refuses a file over the limit without reading it", async () => {
    const { sent, transport } = fakeTransport((message) =>
      reply(message, { data_b64: "", eof: false, sha256: null, size: 5000 })
    );
    const backend = createRemoteBackend(transport, root);

    const result = await backend.readFile("/big.bin", 1000);

    expect(result).toEqual({
      ok: false,
      reason: "File is 5000 bytes, over the 1000 byte limit.",
    });
    expect(sent).toHaveLength(1);
  });

  test("keeps the daemon's own message for a missing file", async () => {
    const { transport } = fakeTransport((message) => ({
      error: {
        code: "not_found",
        message: `no such file: ${String(message.path)}`,
      },
      id: message.id,
    }));
    const backend = createRemoteBackend(transport, root);

    expect(await backend.readFile("/nope", 100)).toEqual({
      ok: false,
      reason: `no such file: ${ROOT}/nope`,
    });
  });
});

describe("file_put", () => {
  test("writes a large file in chunks, with the digest on the final one only", async () => {
    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 10).fill(66);
    const { sent, transport } = fakeTransport((message) => {
      if (message.op === "file_get") {
        return {
          error: { code: "not_found", message: "missing" },
          id: message.id,
        };
      }
      if (message.op === "exec") {
        return reply(message, execOk());
      }
      return reply(message, {
        bytes_written: bytes.length,
        sha256: message.final === true ? "digest" : null,
      });
    });
    const backend = createRemoteBackend(transport, root);

    const result = await backend.writeFileBytes("/big.bin", bytes);

    expect(result).toEqual({ created: true, ok: true, size: bytes.length });
    const puts = sent.filter((message) => message.op === "file_put");
    expect(puts.map((message) => message.seq)).toEqual([0, 1]);
    expect(puts.map((message) => message.final)).toEqual([false, true]);
    expect(puts[0]?.sha256).toBeNull();
    expect(puts[1]?.sha256).toBe(await digestOf(bytes));
    expect(new Set(puts.map((message) => message.transfer_id)).size).toBe(1);
    expect(puts[1]?.path).toBe(`${ROOT}/big.bin`);
  });

  test("an existing file is not reported as created", async () => {
    const { transport } = fakeTransport((message) => {
      if (message.op === "file_get") {
        return reply(message, {
          data_b64: "",
          eof: true,
          sha256: null,
          size: 3,
        });
      }
      if (message.op === "exec") {
        return reply(message, execOk());
      }
      return reply(message, { bytes_written: 2, sha256: "digest" });
    });
    const backend = createRemoteBackend(transport, root);

    expect(await backend.writeFile("/a.txt", "hi")).toEqual({
      created: false,
      ok: true,
      size: 2,
    });
  });

  test("creates the parent directory on the host first, quoted", async () => {
    const { sent, transport } = fakeTransport((message) => {
      if (message.op === "file_get") {
        return {
          error: { code: "not_found", message: "missing" },
          id: message.id,
        };
      }
      if (message.op === "exec") {
        return reply(message, execOk());
      }
      return reply(message, { bytes_written: 0, sha256: "digest" });
    });
    const backend = createRemoteBackend(transport, root);

    await backend.writeFile("/it's/a.txt", "");

    expect(sent.find((message) => message.op === "exec")?.command).toBe(
      `mkdir -p '${ROOT}/it'\\''s'`
    );
  });
});

describe("editFile", () => {
  test("replaces the one occurrence and writes the file back", async () => {
    const stored = new TextEncoder().encode("hello world");
    const { transport } = fakeTransport((message) => {
      if (message.op === "file_get") {
        return reply(message, {
          data_b64: base64Of(stored),
          eof: true,
          sha256: null,
          size: stored.length,
        });
      }
      if (message.op === "exec") {
        return reply(message, execOk());
      }
      return reply(message, { bytes_written: 11, sha256: "digest" });
    });
    const backend = createRemoteBackend(transport, root);

    const result = await backend.editFile("/a.txt", "world", "there");

    expect(result).toEqual({ created: false, ok: true, size: 11 });
  });

  test("refuses when the old string appears more than once", async () => {
    const stored = new TextEncoder().encode("a a");
    const { transport } = fakeTransport((message) =>
      reply(message, {
        data_b64: base64Of(stored),
        eof: true,
        sha256: null,
        size: stored.length,
      })
    );
    const backend = createRemoteBackend(transport, root);

    expect(await backend.editFile("/a.txt", "a", "b")).toEqual({
      ok: false,
      reason:
        "old_string appears 2 times in /a.txt; include enough surrounding context to make it unique.",
    });
  });
});

describe("listDir", () => {
  test("parses the find listing into entries, names with spaces included", async () => {
    const stdout = "d 4096 notes dir\0f 12 a.txt\0";
    const { sent, transport } = fakeTransport((message) =>
      reply(message, execOk(stdout))
    );
    const backend = createRemoteBackend(transport, root);

    expect(await backend.listDir("/")).toEqual({
      entries: [
        { directory: true, name: "notes dir", size: 4096 },
        { directory: false, name: "a.txt", size: 12 },
      ],
      ok: true,
    });
    expect(String(sent[0]?.command)).toContain(`find '${ROOT}/' -mindepth 1`);
  });
});

describe("ping", () => {
  test("a host that runs a no-op command answers", async () => {
    const { transport } = fakeTransport((message) => reply(message, execOk()));

    expect(await ping(transport)).toEqual({
      hostname: null,
      ok: true,
      uptimeMs: null,
      version: null,
    });
  });

  test("a host that does not answer says why", async () => {
    const { transport } = fakeTransport(() => {
      throw new ComputerTransportError("The computer host is offline.");
    });

    expect(await ping(transport)).toEqual({
      ok: false,
      reason: "The computer host is offline.",
    });
  });
});

describe("replies", () => {
  test("a reply for another id is refused, not used", async () => {
    const { transport } = fakeTransport(() => ({
      id: "someone-else",
      result: execOk("wrong"),
    }));
    const backend = createRemoteBackend(transport, root);

    const result = await backend.exec("ls");

    expect(result.ok).toBe(false);
  });
});
