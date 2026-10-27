import { describe, expect, test } from "bun:test";
import {
  parseBridgeMessage,
  toolsCallResultSchema,
} from "@repo/protocol/artifacts";
import { BRIDGE_ERROR, BridgeError } from "./frame-bridge.ts";
import {
  createCallHandlers,
  type FrameCalls,
  LinkCallError,
  type LinkCalls,
  linkCallsFromFetch,
  type MemberCalls,
  type MemberTrpc,
  memberCallsFromTrpc,
} from "./frame-calls.ts";

function msg<M extends string>(method: M, params: unknown) {
  const parsed = parseBridgeMessage({ id: 1, jsonrpc: "2.0", method, params });
  if (!parsed) {
    throw new Error(`bad fixture ${method}`);
  }
  return parsed;
}

// Handlers are keyed by method; the table is loosely typed for the tests.
type AnyHandler = (message: unknown) => Promise<unknown>;
const handlersOf = (options: Parameters<typeof createCallHandlers>[0]) =>
  createCallHandlers(options) as unknown as Record<string, AnyHandler>;

const run = (
  handlers: Record<string, AnyHandler>,
  method: string,
  params: unknown
) => handlers[method]?.(msg(method, params)) as Promise<unknown>;

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as BridgeError;
  }
  throw new Error("expected a rejection");
};

function fakeMember(overrides: Partial<MemberCalls> = {}) {
  const log: { method: string; input: unknown }[] = [];
  const calls: MemberCalls = {
    callTool: (input) => {
      log.push({ input, method: "callTool" });
      return Promise.resolve({ result: { ok: true } });
    },
    storageDelete: (input) => {
      log.push({ input, method: "storageDelete" });
      return Promise.resolve({ extra: 1 });
    },
    storageGet: (input) => {
      log.push({ input, method: "storageGet" });
      return Promise.resolve({ value: { a: 1 } });
    },
    storageList: (input) => {
      log.push({ input, method: "storageList" });
      return Promise.resolve({ keys: ["a", "b"] });
    },
    storageSet: (input) => {
      log.push({ input, method: "storageSet" });
      return Promise.resolve({ extra: 1 });
    },
    ...overrides,
  };
  return { calls: { viewer: "member", ...calls } as FrameCalls, log };
}

describe("member handlers", () => {
  test("storage methods call the port and answer the fixed shapes", async () => {
    const { calls, log } = fakeMember();
    const h = handlersOf({ calls });
    expect(await run(h, "storage/get", { key: "k", scope: "viewer" })).toEqual({
      value: { a: 1 },
    });
    expect(
      await run(h, "storage/list", { prefix: "p", scope: "shared" })
    ).toEqual({ keys: ["a", "b"] });
    expect(
      await run(h, "storage/set", { key: "k", scope: "shared", value: [1] })
    ).toEqual({});
    expect(
      await run(h, "storage/delete", { key: "k", scope: "viewer" })
    ).toEqual({});
    expect(log).toEqual([
      { input: { key: "k", scope: "viewer" }, method: "storageGet" },
      { input: { prefix: "p", scope: "shared" }, method: "storageList" },
      {
        input: { key: "k", scope: "shared", value: [1] },
        method: "storageSet",
      },
      { input: { key: "k", scope: "viewer" }, method: "storageDelete" },
    ]);
  });

  test("tools/call passes name and arguments and shapes results", async () => {
    const results: unknown[] = ["plain", { a: 1 }, undefined, null];
    const seen: unknown[] = [];
    const queue = [...results];
    const { calls } = fakeMember({
      callTool: (input) => {
        seen.push(input);
        return Promise.resolve({ result: queue.shift() });
      },
    });
    const h = handlersOf({ calls });
    const answers = await Promise.all(
      results.map(() =>
        run(h, "tools/call", { arguments: { x: 1 }, name: "t" })
      )
    );
    expect(seen[0]).toEqual({ arguments: { x: 1 }, tool: "t" });
    expect(answers[0]).toEqual({
      content: [{ text: "plain", type: "text" }],
      structuredContent: "plain",
    });
    expect(answers[1]).toEqual({
      content: [{ text: '{"a":1}', type: "text" }],
      structuredContent: { a: 1 },
    });
    expect(answers[2]).toEqual({ content: [{ text: "", type: "text" }] });
    expect("structuredContent" in (answers[2] as object)).toBe(false);
    expect(answers[3]).toEqual({
      content: [{ text: "null", type: "text" }],
      structuredContent: null,
    });
    for (const answer of answers) {
      expect(toolsCallResultSchema.safeParse(answer).success).toBe(true);
    }
  });
});

describe("error mapping", () => {
  const rows: [string, number, string][] = [
    [
      "UNAUTHORIZED",
      BRIDGE_ERROR.denied,
      "Your session has ended. Reload the page to sign in again.",
    ],
    [
      "FORBIDDEN",
      BRIDGE_ERROR.denied,
      "This artifact isn't allowed to do that.",
    ],
    ["NOT_FOUND", BRIDGE_ERROR.denied, "Artifact or version not found."],
    [
      "PRECONDITION_FAILED",
      BRIDGE_ERROR.failed,
      "Connect this tool first, then try again.",
    ],
    [
      "TOO_MANY_REQUESTS",
      BRIDGE_ERROR.failed,
      "Too many calls. Try again shortly.",
    ],
    ["PAYLOAD_TOO_LARGE", BRIDGE_ERROR.failed, "The result is too large."],
    [
      "BAD_REQUEST",
      BRIDGE_ERROR.failed,
      "The request was not accepted. Check the key, value and size.",
    ],
    ["INTERNAL_SERVER_ERROR", BRIDGE_ERROR.failed, "The call failed."],
  ];

  for (const [code, rpcCode, text] of rows) {
    for (const shape of ["data", "shape"] as const) {
      test(`${code} via ${shape}`, async () => {
        const error =
          shape === "data"
            ? Object.assign(new Error("server secret"), { data: { code } })
            : Object.assign(new Error("server secret"), {
                shape: { data: { code } },
              });
        const { calls } = fakeMember({
          callTool: () => Promise.reject(error),
        });
        const caught = await rejection(
          run(handlersOf({ calls }), "tools/call", { name: "t" })
        );
        expect(caught).toBeInstanceOf(BridgeError);
        expect(caught.code).toBe(rpcCode);
        expect(caught.message).toBe(text);
      });
    }
  }

  test("a plain Error never leaks its text", async () => {
    const { calls } = fakeMember({
      storageGet: () => Promise.reject(new Error("db password is hunter2")),
    });
    const caught = await rejection(
      run(handlersOf({ calls }), "storage/get", { key: "k", scope: "viewer" })
    );
    expect(caught.code).toBe(BRIDGE_ERROR.failed);
    expect(caught.message).toBe("The call failed.");
  });

  test("a thrown BridgeError passes through", async () => {
    const own = new BridgeError(BRIDGE_ERROR.denied, "mine");
    const { calls } = fakeMember({ callTool: () => Promise.reject(own) });
    const caught = await rejection(
      run(handlersOf({ calls }), "tools/call", { name: "t" })
    );
    expect(caught).toBe(own);
  });

  const linkRows: [number, number, string][] = [
    [403, BRIDGE_ERROR.denied, "This link doesn't allow that tool."],
    [404, BRIDGE_ERROR.denied, "This link is not available."],
    [429, BRIDGE_ERROR.failed, "Too many calls. Try again shortly."],
    [500, BRIDGE_ERROR.failed, "The call failed."],
    [0, BRIDGE_ERROR.failed, "The call failed."],
  ];
  for (const [status, rpcCode, text] of linkRows) {
    test(`link status ${status}`, async () => {
      const calls: FrameCalls = {
        callTool: () => Promise.reject(new LinkCallError(status)),
        storageGet: () => Promise.resolve({ value: null }),
        storageList: () => Promise.resolve({ keys: [] }),
        viewer: "link",
      };
      const caught = await rejection(
        run(handlersOf({ calls }), "tools/call", { name: "t" })
      );
      expect(caught.code).toBe(rpcCode);
      expect(caught.message).toBe(text);
    });
  }
});

describe("link viewer", () => {
  const seen: unknown[] = [];
  const makeCalls = (): Extract<FrameCalls, { viewer: "link" }> => ({
    callTool: (input) => {
      seen.push(["tool", input]);
      return Promise.resolve({ result: "hi" });
    },
    storageGet: (input) => {
      seen.push(["get", input]);
      return Promise.resolve({ value: { n: 1 } });
    },
    storageList: (input) => {
      seen.push(["list", input]);
      return Promise.resolve({ keys: ["a", "b"] });
    },
    viewer: "link",
  });

  test("tools go to the link port", async () => {
    seen.length = 0;
    const h = handlersOf({ calls: makeCalls() });
    expect(await run(h, "tools/call", { name: "t" })).toEqual({
      content: [{ text: "hi", type: "text" }],
      structuredContent: "hi",
    });
    expect(seen).toEqual([["tool", { arguments: undefined, tool: "t" }]]);
  });

  test("the shared area can be read and listed", async () => {
    seen.length = 0;
    const h = handlersOf({ calls: makeCalls() });
    expect(
      await run(h, "storage/get", { key: "note", scope: "shared" })
    ).toEqual({ value: { n: 1 } });
    expect(
      await run(h, "storage/list", { prefix: "n", scope: "shared" })
    ).toEqual({ keys: ["a", "b"] });
    expect(seen).toEqual([
      ["get", { key: "note" }],
      ["list", { prefix: "n" }],
    ]);
  });

  test("the viewer area is refused for reads, and writes are refused in both", async () => {
    seen.length = 0;
    const h = handlersOf({ calls: makeCalls() });
    const reads = await Promise.all([
      rejection(run(h, "storage/get", { key: "k", scope: "viewer" })),
      rejection(run(h, "storage/list", { scope: "viewer" })),
    ]);
    for (const caught of reads) {
      expect(caught.code).toBe(BRIDGE_ERROR.denied);
      expect(caught.message).toBe(
        "Shared links can read only the shared area."
      );
    }
    const writes = await Promise.all(
      ["viewer", "shared"].flatMap((scope) => [
        rejection(run(h, "storage/set", { key: "k", scope, value: 1 })),
        rejection(run(h, "storage/delete", { key: "k", scope })),
      ])
    );
    for (const caught of writes) {
      expect(caught.code).toBe(BRIDGE_ERROR.denied);
      expect(caught.message).toBe("Shared links can't change app storage.");
    }
    expect(seen).toHaveLength(0);
  });

  test("a storage failure on the link route maps like a tool failure", async () => {
    const h = handlersOf({
      calls: {
        ...makeCalls(),
        storageGet: () => Promise.reject(new LinkCallError(429)),
        viewer: "link",
      },
    });
    const caught = await rejection(
      run(h, "storage/get", { key: "k", scope: "shared" })
    );
    expect(caught.code).toBe(BRIDGE_ERROR.failed);
    expect(caught.message).toBe("Too many calls. Try again shortly.");
  });
});

describe("ui/message", () => {
  const params = (...texts: string[]) => ({
    content: texts.map((text) => ({ text, type: "text" })),
    role: "user",
  });

  test("joins text blocks and awaits onMessage", async () => {
    const got: string[] = [];
    const { calls } = fakeMember();
    const h = handlersOf({
      calls,
      onMessage: async (text) => {
        await Promise.resolve();
        got.push(text);
      },
    });
    expect(await run(h, "ui/message", params("a", "b"))).toEqual({});
    expect(got).toEqual(["a\nb"]);
  });

  test("refused without onMessage", async () => {
    const { calls } = fakeMember();
    const caught = await rejection(
      run(handlersOf({ calls }), "ui/message", params("a"))
    );
    expect(caught.code).toBe(BRIDGE_ERROR.denied);
    expect(caught.message).toBe(
      "This viewer doesn't take messages from the artifact."
    );
  });

  test("cap is 8000 characters", async () => {
    const got: string[] = [];
    const { calls } = fakeMember();
    const h = handlersOf({
      calls,
      onMessage: (t) => {
        got.push(t);
      },
    });
    await run(h, "ui/message", params("x".repeat(8000)));
    expect(got).toHaveLength(1);
    const caught = await rejection(
      run(h, "ui/message", params("x".repeat(8001)))
    );
    expect(caught.code).toBe(BRIDGE_ERROR.denied);
    expect(caught.message).toBe("That message is too long.");
    expect(got).toHaveLength(1);
  });

  test("an onMessage failure is mapped", async () => {
    const { calls } = fakeMember();
    const h = handlersOf({
      calls,
      onMessage: () => {
        throw new Error("secret");
      },
    });
    const caught = await rejection(run(h, "ui/message", params("a")));
    expect(caught.message).toBe("The call failed.");
  });
});

describe("memberCallsFromTrpc", () => {
  test("adds the ids to every call", async () => {
    const log: unknown[] = [];
    const rec = (name: string) => (input: unknown) => {
      log.push([name, input]);
      return Promise.resolve({ keys: [], result: 1, value: null });
    };
    const trpc: MemberTrpc = {
      artifacts: {
        callTool: { mutate: rec("callTool") },
        storageDelete: { mutate: rec("storageDelete") },
        storageGet: { query: rec("storageGet") },
        storageList: { query: rec("storageList") },
        storageSet: { mutate: rec("storageSet") },
      },
    };
    const calls = memberCallsFromTrpc(trpc, {
      artifactId: "a",
      versionId: "v",
    });
    await calls.callTool({ arguments: { x: 1 }, tool: "t" });
    await calls.storageGet({ key: "k", scope: "viewer" });
    await calls.storageList({ prefix: "p", scope: "shared" });
    await calls.storageSet({ key: "k", scope: "shared", value: 2 });
    await calls.storageDelete({ key: "k", scope: "viewer" });
    expect(log).toEqual([
      [
        "callTool",
        { arguments: { x: 1 }, artifactId: "a", tool: "t", versionId: "v" },
      ],
      ["storageGet", { artifactId: "a", key: "k", scope: "viewer" }],
      ["storageList", { artifactId: "a", prefix: "p", scope: "shared" }],
      ["storageSet", { artifactId: "a", key: "k", scope: "shared", value: 2 }],
      ["storageDelete", { artifactId: "a", key: "k", scope: "viewer" }],
    ]);
  });
});

describe("linkCallsFromFetch", () => {
  const makeFetch = (respond: () => Response | Promise<Response>) => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = ((url: string, init?: RequestInit) => {
      seen.push({ init, url });
      return Promise.resolve(respond());
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  };
  const status = async (calls: LinkCalls) => {
    try {
      await calls.callTool({ tool: "t" });
    } catch (error) {
      return (error as LinkCallError).status;
    }
    return null;
  };

  test("200 returns the result and posts the right request", async () => {
    const { fetchFn, seen } = makeFetch(() =>
      Response.json({ result: { a: 1 } })
    );
    const calls = linkCallsFromFetch("tok/en ?", fetchFn);
    expect(await calls.callTool({ arguments: { x: 1 }, tool: "t" })).toEqual({
      result: { a: 1 },
    });
    await calls.callTool({ tool: "t" });
    expect(seen[0]?.url).toBe("/api/share/tok%2Fen%20%3F/call");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.headers).toEqual({
      "content-type": "application/json",
    });
    expect(JSON.parse(seen[0]?.init?.body as string)).toEqual({
      arguments: { x: 1 },
      tool: "t",
    });
    expect(seen[1]?.init?.body).toBe('{"tool":"t"}');
  });

  for (const code of [403, 404, 429, 500]) {
    test(`status ${code} throws LinkCallError(${code})`, async () => {
      const { fetchFn } = makeFetch(() => new Response("{}", { status: code }));
      expect(await status(linkCallsFromFetch("t", fetchFn))).toBe(code);
    });
  }

  test("storage reads post to the storage route and unwrap the result", async () => {
    const results = [{ n: 1 }, null, ["a", "b"], "not a list"];
    const { fetchFn, seen } = makeFetch(() =>
      Response.json({ result: results.shift() })
    );
    const calls = linkCallsFromFetch("t", fetchFn);
    expect(await calls.storageGet({ key: "k" })).toEqual({ value: { n: 1 } });
    expect(await calls.storageGet({ key: "k" })).toEqual({ value: null });
    expect(await calls.storageList({ prefix: "p" })).toEqual({
      keys: ["a", "b"],
    });
    await expect(calls.storageList({})).rejects.toMatchObject({ status: 502 });
    expect(seen.map((entry) => entry.url)).toEqual(
      new Array(4).fill("/api/share/t/storage")
    );
    expect(seen.map((entry) => entry.init?.body)).toEqual([
      '{"key":"k","op":"get"}',
      '{"key":"k","op":"get"}',
      '{"op":"list","prefix":"p"}',
      '{"op":"list"}',
    ]);
  });

  test("a refused storage read throws the status", async () => {
    const { fetchFn } = makeFetch(() => new Response("{}", { status: 403 }));
    await expect(
      linkCallsFromFetch("t", fetchFn).storageGet({ key: "k" })
    ).rejects.toMatchObject({ status: 403 });
  });

  test("network failure is status 0", async () => {
    const fetchFn = (() =>
      Promise.reject(new TypeError("down"))) as unknown as typeof fetch;
    expect(await status(linkCallsFromFetch("t", fetchFn))).toBe(0);
  });

  test("bad bodies are status 502", async () => {
    const statuses = await Promise.all(
      ["not json", '{"nope":1}'].map((body) => {
        const { fetchFn } = makeFetch(
          () => new Response(body, { status: 200 })
        );
        return status(linkCallsFromFetch("t", fetchFn));
      })
    );
    expect(statuses).toEqual([502, 502]);
  });
});
