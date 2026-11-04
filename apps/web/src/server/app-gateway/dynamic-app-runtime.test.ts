import { describe, expect, test } from "bun:test";
import { dynamicAppRuntime } from "./dynamic-app-runtime.ts";
import type { AppBundle } from "./ports.ts";
import type { AppHostProps } from "./types.ts";

const encoder = new TextEncoder();
const host = (
  viewer: AppHostProps["viewer"],
  versionId = "v1"
): AppHostProps => ({
  artifactId: "a1",
  meta: { ipPrefix: null, place: null, userAgent: null, visitorHash: "vh" },
  versionId,
  viewer,
  workspaceId: "ws-1",
});
const bundle = (declaresHosts: boolean): AppBundle => ({
  declaresHosts,
  files: [
    {
      bytes: encoder.encode(
        "export default { fetch() { return new Response('x') } }"
      ),
      path: "server/index.js",
    },
  ],
});

/** A WorkerLoader that keeps what the callback returned, once per id, as the real one does. */
const fakeLoader = () => {
  const configs = new Map<string, Promise<Record<string, unknown>>>();
  const calls: { args: unknown[]; entry: string }[] = [];
  const loader = {
    get: (id: string, callback: () => Promise<Record<string, unknown>>) => {
      if (!configs.has(id)) {
        configs.set(id, callback());
      }
      return {
        getEntrypoint: (entry: string) => ({
          handle: (...args: unknown[]) => {
            calls.push({ args, entry });
            return Promise.resolve(new Response("ok"));
          },
        }),
      };
    },
  } as unknown as WorkerLoader;
  return { calls, configs, loader };
};

const setup = (declaresHosts: boolean) => {
  const fake = fakeLoader();
  const hostStubs: AppHostProps[] = [];
  const outboundProps: unknown[] = [];
  let bundleReads = 0;
  const runtime = dynamicAppRuntime({
    hostStub: (props) => {
      hostStubs.push(props);
      return { stub: props.viewer };
    },
    loader: fake.loader,
    outboundStub: (props) => {
      outboundProps.push(props);
      return { outbound: true } as unknown as Fetcher;
    },
  });
  const run = (props: AppHostProps) =>
    runtime.handle({
      bundle: () => {
        bundleReads += 1;
        return Promise.resolve(bundle(declaresHosts));
      },
      host: props,
      request: new Request("https://app.test/api/x"),
    });
  return {
    bundleReads: () => bundleReads,
    fake,
    hostStubs,
    outboundProps,
    run,
  };
};

describe("dynamicAppRuntime", () => {
  test("the Worker is cached as app:<versionId> and its config holds nothing about the viewer", async () => {
    const t = setup(false);
    await t.run(host({ kind: "member", userId: "alice" }));
    await t.run(host({ kind: "member", userId: "bob" }));
    expect([...t.fake.configs.keys()]).toEqual(["app:v1"]);
    const config = await t.fake.configs.get("app:v1");
    expect(JSON.stringify(config)).not.toContain("alice");
    expect(config).toMatchObject({
      compatibilityDate: "2026-08-19",
      env: {},
      limits: { subRequests: 50 },
      mainModule: "__harness.js",
    });
    expect(Object.keys((config?.modules ?? {}) as object).sort()).toEqual([
      "__harness.js",
      "server/index.js",
    ]);
  });

  test("each request gets its own AgentumHost stub, passed to the Harness entrypoint", async () => {
    const t = setup(false);
    await t.run(host({ kind: "member", userId: "alice" }));
    await t.run(host({ kind: "member", userId: "bob" }));
    expect(t.fake.calls.map((c) => c.entry)).toEqual(["Harness", "Harness"]);
    expect(
      t.fake.calls.map(
        (c) => (c.args[1] as { stub: { userId: string } }).stub.userId
      )
    ).toEqual(["alice", "bob"]);
    expect(t.hostStubs.length).toBe(2);
  });

  test("a new version is a new Worker, and the bundle is read once per version", async () => {
    const t = setup(false);
    await t.run(host({ kind: "test" }, "v1"));
    await t.run(host({ kind: "test" }, "v1"));
    await t.run(host({ kind: "test" }, "v2"));
    expect([...t.fake.configs.keys()]).toEqual(["app:v1", "app:v2"]);
    expect(t.bundleReads()).toBe(2);
  });

  test("a version that declares no host has globalOutbound null", async () => {
    const t = setup(false);
    await t.run(host({ kind: "test" }));
    expect((await t.fake.configs.get("app:v1"))?.globalOutbound).toBeNull();
    expect(t.outboundProps).toEqual([]);
  });

  test("a version that declares hosts gets the outbound entrypoint with ids only", async () => {
    const t = setup(true);
    await t.run(host({ kind: "member", userId: "alice" }));
    expect((await t.fake.configs.get("app:v1"))?.globalOutbound).toEqual({
      outbound: true,
    });
    expect(t.outboundProps).toEqual([
      { artifactId: "a1", versionId: "v1", workspaceId: "ws-1" },
    ]);
  });

  test("a version with no server part fails the call", async () => {
    const fake = fakeLoader();
    const runtime = dynamicAppRuntime({
      hostStub: () => ({}),
      loader: fake.loader,
      outboundStub: () => ({}) as Fetcher,
    });
    const config = runtime.handle({
      bundle: () => Promise.resolve(null),
      host: host({ kind: "test" }),
      request: new Request("https://app.test/api"),
    });
    await expect(config).resolves.toBeDefined();
    await expect(fake.configs.get("app:v1")).rejects.toThrow("no server part");
  });
});

test("reply skips a live version with no server part", async () => {
  const runtime = dynamicAppRuntime({
    hostStub: () => {
      throw new Error("must not create host");
    },
    loader: {
      get: () => {
        throw new Error("must not load worker");
      },
    } as unknown as WorkerLoader,
    outboundStub: () => {
      throw new Error("must not create outbound");
    },
  });
  await expect(
    runtime.reply({
      bundle: async () => null,
      host: host({ kind: "reply", runId: "r1" }),
      message: {
        fileIds: [],
        runId: "r1",
        state: "",
        status: "finished",
        text: "done",
      },
    })
  ).resolves.toBeUndefined();
});
