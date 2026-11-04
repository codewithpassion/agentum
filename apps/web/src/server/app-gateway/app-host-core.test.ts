import { describe, expect, test } from "bun:test";
import { createAppHost } from "./app-host-core.ts";
import { fakePorts } from "./fakes.ts";
import type { AppHostProps } from "./types.ts";

const meta = { ipPrefix: null, place: null, userAgent: null, visitorHash: "v" };
const base = { artifactId: "a1", meta, versionId: "v1", workspaceId: "ws-1" };

const member = (userId = "alice"): AppHostProps => ({
  ...base,
  viewer: { kind: "member", userId },
});
const link: AppHostProps = {
  ...base,
  viewer: { dataMode: "live", kind: "link", shareId: "s1" },
};
const test_: AppHostProps = { ...base, viewer: { kind: "test" } };

const failure = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
};

describe("createAppHost: members", () => {
  test("a member keeps a private viewer area and shares the shared one", async () => {
    const ports = fakePorts();
    const alice = createAppHost(member("alice"), ports);
    const bob = createAppHost(member("bob"), ports);
    await alice.setItem("viewer", "k", "alice-private");
    await alice.setItem("shared", "k", "everyone");
    expect(await bob.getItem("viewer", "k")).toBeNull();
    expect(await alice.getItem("viewer", "k")).toBe("alice-private");
    expect(await bob.getItem("shared", "k")).toBe("everyone");
    await bob.deleteItem("shared", "k");
    expect(await alice.getItem("shared", "k")).toBeNull();
  });

  test("whoami says member", async () => {
    expect(await createAppHost(member(), fakePorts()).whoami()).toEqual({
      dataMode: null,
      viewer: "member",
    });
  });

  test("listItems filters by prefix and clamps the limit", async () => {
    const ports = fakePorts();
    const host = createAppHost(member(), ports);
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => host.setItem("shared", `sub/${i}`, String(i)))
    );
    await host.setItem("shared", "other", "x");
    expect((await host.listItems("shared", "sub/")).length).toBe(5);
    expect((await host.listItems("shared", "sub/", 2)).length).toBe(2);
    expect((await host.listItems("shared", "sub/", -4)).length).toBe(1);
    expect((await host.listItems("shared", "sub/", Number.NaN)).length).toBe(5);
  });

  test("a key or value over the limit is too_large, and the store is not reached", async () => {
    const ports = fakePorts();
    const host = createAppHost(member(), ports);
    expect(
      await failure(host.setItem("shared", "k".repeat(257), "v"))
    ).toStartWith("too_large:");
    expect(
      await failure(host.setItem("shared", "k", "v".repeat(1024 * 1024 + 1)))
    ).toStartWith("too_large:");
    expect(await failure(host.setItem("shared", "", "v"))).toContain(
      "non-empty"
    );
    expect(ports.store.rows.size).toBe(0);
  });

  test("a store refusal passes through", async () => {
    const ports = fakePorts();
    ports.store.set = () => Promise.reject(new Error("quota_exceeded: 1 > 0"));
    expect(
      await failure(createAppHost(member(), ports).setItem("shared", "k", "v"))
    ).toBe("quota_exceeded: 1 > 0");
  });

  test("callTool goes to the member path with the ids from the props", async () => {
    const ports = fakePorts();
    await createAppHost(member("alice"), ports).callTool("srv/tool", { a: 1 });
    expect(ports.calls.seen).toEqual([
      {
        args: { a: 1 },
        artifactId: "a1",
        tool: "srv/tool",
        userId: "alice",
        versionId: "v1",
        via: "member",
        workspaceId: "ws-1",
      },
    ]);
  });

  test("a tool key without a server part is not_granted", async () => {
    const ports = fakePorts();
    expect(
      await failure(createAppHost(member(), ports).callTool("tool", {}))
    ).toBe("not_granted: tool");
    expect(ports.calls.seen).toEqual([]);
  });
});

describe("createAppHost: link viewers", () => {
  test("a live link writes only its own area, under the link's key", async () => {
    const ports = fakePorts();
    ports.share.state = { dataMode: "live", ok: true };
    const host = createAppHost(link, ports);
    await host.setItem("viewer", "k", "v");
    expect([...ports.store.rows.keys()]).toEqual(["a1|viewer|l:s1|k"]);
    expect(await failure(host.setItem("shared", "k", "v"))).toStartWith(
      "forbidden:"
    );
    expect(await failure(host.deleteItem("shared", "k"))).toStartWith(
      "forbidden:"
    );
  });

  test("the data mode is read fresh, not taken from the props", async () => {
    const ports = fakePorts();
    ports.share.state = { dataMode: "snapshot", ok: true };
    const host = createAppHost(link, ports);
    expect(await failure(host.setItem("viewer", "k", "v"))).toStartWith(
      "forbidden:"
    );
    expect(await host.whoami()).toEqual({
      dataMode: "snapshot",
      viewer: "link",
    });
  });

  test("a snapshot link reads the shared area and cannot call tools", async () => {
    const ports = fakePorts();
    ports.share.state = { dataMode: "snapshot", ok: true };
    await ports.store.set(
      { area: "shared", artifactId: "a1", viewerKey: "" },
      "k",
      "v"
    );
    const host = createAppHost(link, ports);
    expect(await host.getItem("shared", "k")).toBe("v");
    expect(await failure(host.callTool("srv/tool", {}))).toBe(
      "forbidden: snapshot links cannot call tools"
    );
    expect(ports.calls.seen).toEqual([]);
  });

  test("a live link's call goes through the link path with the meta", async () => {
    const ports = fakePorts();
    ports.share.state = { dataMode: "live", ok: true };
    await createAppHost(link, ports).callTool("srv/tool", {});
    expect(ports.calls.seen).toMatchObject([
      { meta, shareId: "s1", via: "link" },
    ]);
  });

  test("a link that is revoked is refused on the next read, write and call", async () => {
    const ports = fakePorts();
    ports.share.state = { dataMode: "live", ok: true };
    const host = createAppHost(link, ports);
    await host.setItem("viewer", "k", "v");
    ports.share.state = { ok: false, reason: "revoked" };
    expect(await failure(host.getItem("viewer", "k"))).toBe(
      "forbidden: link is revoked"
    );
    expect(await failure(host.listItems("viewer"))).toBe(
      "forbidden: link is revoked"
    );
    expect(await failure(host.setItem("viewer", "k", "w"))).toBe(
      "forbidden: link is revoked"
    );
    expect(await failure(host.deleteItem("viewer", "k"))).toBe(
      "forbidden: link is revoked"
    );
    expect(await failure(host.callTool("srv/tool", {}))).toBe(
      "forbidden: link is revoked"
    );
    expect(ports.calls.seen).toEqual([]);
  });
});

describe("createAppHost: test viewer", () => {
  test("reads the shared area, sees nothing of a person's own, writes and calls nothing", async () => {
    const ports = fakePorts();
    await ports.store.set(
      { area: "shared", artifactId: "a1", viewerKey: "" },
      "k",
      "v"
    );
    const host = createAppHost(test_, ports);
    expect(await host.getItem("shared", "k")).toBe("v");
    expect(await host.getItem("viewer", "k")).toBeNull();
    expect(await host.listItems("viewer")).toEqual([]);
    expect(await failure(host.setItem("shared", "k", "x"))).toStartWith(
      "forbidden:"
    );
    expect(await failure(host.deleteItem("shared", "k"))).toStartWith(
      "forbidden:"
    );
    expect(await failure(host.callTool("srv/tool", {}))).toStartWith(
      "forbidden:"
    );
    expect(await host.whoami()).toEqual({ dataMode: null, viewer: "test" });
  });
});

describe("createAppHost: arguments from app code", () => {
  test("an area other than viewer or shared is refused on every method", async () => {
    const ports = fakePorts();
    const host = createAppHost(member(), ports);
    const area = "made-up" as never;
    expect(await failure(host.setItem(area, "k", "v"))).toContain("area");
    expect(await failure(host.deleteItem(area, "k"))).toContain("area");
    expect(await failure(host.getItem(area, "k"))).toContain("area");
    expect(await failure(host.listItems(area))).toContain("area");
    expect(ports.store.rows.size).toBe(0);
  });

  test("listItems without a prefix lists everything in the area", async () => {
    const host = createAppHost(member(), fakePorts());
    await host.setItem("shared", "a", "1");
    await host.setItem("shared", "b", "2");
    expect((await host.listItems("shared")).length).toBe(2);
    expect((await host.listItems("shared", undefined, undefined)).length).toBe(
      2
    );
  });
});

describe("app hand-off", () => {
  test("only an endpoint viewer can start a run", async () => {
    for (const props of [
      member(),
      link,
      test_,
      { ...base, viewer: { kind: "reply", runId: "r1" } } as AppHostProps,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: verify each refused viewer
      await expect(
        createAppHost(props, fakePorts()).startRun({
          agent: "agent",
          text: "hi",
        })
      ).rejects.toThrow("forbidden:");
    }
  });
  test("an endpoint delegates the trusted app ids and keeps state", async () => {
    const seen: unknown[] = [];
    const ports = {
      ...fakePorts(),
      startRun: (trusted: AppHostProps, input: unknown) => {
        seen.push({ input, props: trusted });
        return Promise.resolve({ runId: "r1" });
      },
    };
    const props: AppHostProps = {
      ...base,
      viewer: { endpointId: "ep", kind: "endpoint" },
    };
    expect(
      await createAppHost(props, ports).startRun({
        agent: "agent",
        sessionKey: "channel",
        state: "opaque",
        text: "hi",
      })
    ).toEqual({ runId: "r1" });
    expect(seen).toEqual([
      {
        input: {
          agent: "agent",
          sessionKey: "channel",
          state: "opaque",
          text: "hi",
        },
        props,
      },
    ]);
  });
  test("reply viewers write shared storage but cannot use viewer storage or tools", async () => {
    const host = createAppHost(
      { ...base, viewer: { kind: "reply", runId: "r1" } },
      fakePorts()
    );
    await host.setItem("shared", "reply", "done");
    expect(await host.getItem("shared", "reply")).toBe("done");
    expect(await host.whoami()).toEqual({ dataMode: null, viewer: "reply" });
    await expect(host.getItem("viewer", "x")).rejects.toThrow("forbidden:");
    await expect(host.callTool("srv/tool", {})).rejects.toThrow("forbidden:");
  });
});

test("endpoint viewer can read/write shared storage, but viewer storage and tools are forbidden", async () => {
  const ports = fakePorts();
  const host = createAppHost(
    { ...base, viewer: { endpointId: "ep", kind: "endpoint" } },
    ports
  );
  expect(await host.whoami()).toEqual({ dataMode: null, viewer: "endpoint" });
  await host.setItem("shared", "k", "v");
  expect(await host.getItem("shared", "k")).toBe("v");
  expect(await host.listItems("shared")).toEqual([{ key: "k", value: "v" }]);
  await host.deleteItem("shared", "k");
  expect(await host.getItem("shared", "k")).toBeNull();
  await Promise.all(
    [
      () => host.getItem("viewer", "k"),
      () => host.listItems("viewer"),
      () => host.setItem("viewer", "k", "v"),
      () => host.deleteItem("viewer", "k"),
      () => host.callTool("x/y", {}),
    ].map(async (operation) => {
      expect(await failure(operation())).toStartWith("forbidden:");
    })
  );
  expect(ports.calls.seen).toEqual([]);
});
