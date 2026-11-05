import { describe, expect, test } from "bun:test";
import { ArtifactCallError } from "@repo/services/artifacts/calls";
import { ServiceError } from "@repo/services/errors";
import type { ContentBucket } from "../artifact-content/routes.ts";
import { createAppGatewayPorts } from "./compose-ports.ts";
import { fakeStore } from "./fakes.ts";

const WORKSPACE = "ws_1";
const encoder = new TextEncoder();

const object = (text: string) => ({
  arrayBuffer: () =>
    Promise.resolve(encoder.encode(text).buffer as ArrayBuffer),
  body: new Response(text).body as ReadableStream,
  size: text.length,
});

const PREFIX = {
  failed: /^failed:/,
  forbidden: /^forbidden:/,
  not_granted: /^not_granted:/,
  rate_limited: /^rate_limited:/,
};

const sha = (char: string) => char.repeat(64);

const setup = () => {
  const objects = new Map<string, string>();
  const bucket: ContentBucket = {
    get: (key) => {
      const text = objects.get(key);
      return Promise.resolve(text === undefined ? null : object(text));
    },
  };
  const seen: unknown[] = [];
  const state = {
    callShare: { ok: true, result: { rows: 2 } } as unknown,
    callShareThrows: false as boolean,
    callTool: { result: { n: 1 } } as unknown,
    declares: false,
    member: true as boolean,
    memberThrows: false as boolean,
  };
  const services = {
    artifactApp: {
      declaresHosts: () => Promise.resolve(state.declares),
      memberPrincipal: (userId: string, workspaceId: string) =>
        state.memberThrows
          ? Promise.reject(new Error("Clerk 500: secret detail"))
          : Promise.resolve(
              state.member
                ? ({
                    kind: "user",
                    userId,
                    via: "session",
                    workspaceId,
                  } as const)
                : null
            ),
      outboundPolicy: () =>
        Promise.resolve({
          hosts: ["api.example.com"],
          secretRules: () => Promise.resolve([]),
        }),
      secretRules: () => Promise.resolve([]),
      versionWorkspaceId: (_artifact: string, version: string) =>
        Promise.resolve(version === "gone" ? null : WORKSPACE),
    },
    artifactCalls: {
      callTool: (principal: unknown, input: unknown) => {
        seen.push({ input, principal });
        if (state.callTool instanceof Error) {
          return Promise.reject(state.callTool);
        }
        return Promise.resolve(state.callTool);
      },
    },
    artifactShares: {
      callShare: (...args: unknown[]) => {
        if (state.callShareThrows) {
          return Promise.reject(new Error("D1_ERROR: leaked detail"));
        }
        seen.push({ link: args });
        return Promise.resolve(state.callShare);
      },
      shareState: () => Promise.resolve({ dataMode: "live", ok: true }),
    },
  };
  const ports = createAppGatewayPorts({
    bucket,
    // The fake covers what the ports read.
    services: services as never,
    store: { ...fakeStore(), set: () => Promise.resolve() } as never,
  });
  return { objects, ports, seen, state };
};

const call = {
  args: { q: "x" },
  artifactId: "ar_1",
  tool: "xero/list",
  versionId: "ver_1",
  workspaceId: WORKSPACE,
};

describe("source.bundle", () => {
  test("reads only the server files, with their bytes", async () => {
    const t = setup();
    t.objects.set(
      `${WORKSPACE}/artifact-manifests/ver_1.json`,
      JSON.stringify({
        entry: "index.html",
        files: {
          "index.html": { contentType: "text/html", sha256: sha("a"), size: 1 },
          "server/index.js": {
            contentType: "text/javascript",
            sha256: sha("b"),
            size: 3,
          },
        },
      })
    );
    t.objects.set(`${WORKSPACE}/artifact-blobs/${sha("b")}`, "abc");
    const bundle = await t.ports.source.bundle("ar_1", "ver_1");
    if (!bundle) {
      throw new Error("no bundle");
    }
    expect(bundle.declaresHosts).toBe(false);
    expect(bundle.files.map((file) => file.path)).toEqual(["server/index.js"]);
    expect(new TextDecoder().decode(bundle.files.at(0)?.bytes)).toBe("abc");
  });

  test("a version with no workspace or no manifest is null", async () => {
    const t = setup();
    expect(await t.ports.source.bundle("ar_1", "gone")).toBeNull();
    expect(await t.ports.source.bundle("ar_1", "ver_1")).toBeNull();
  });

  test("a missing blob rejects, so the gateway answers 502", async () => {
    const t = setup();
    t.objects.set(
      `${WORKSPACE}/artifact-manifests/ver_1.json`,
      JSON.stringify({
        entry: "index.html",
        files: {
          "index.html": { contentType: "text/html", sha256: sha("a"), size: 1 },
          "server/index.js": {
            contentType: "text/javascript",
            sha256: sha("b"),
            size: 3,
          },
        },
      })
    );
    await expect(t.ports.source.bundle("ar_1", "ver_1")).rejects.toThrow(
      "missing"
    );
  });
});

describe("calls.asMember", () => {
  test("runs as a rebuilt member principal and returns the result", async () => {
    const t = setup();
    const result = await t.ports.calls.asMember({ ...call, userId: "alice" });
    expect(result).toEqual({ n: 1 });
    expect(t.seen.at(0)).toEqual({
      input: {
        arguments: { q: "x" },
        artifactId: "ar_1",
        tool: "xero/list",
        versionId: "ver_1",
      },
      principal: {
        kind: "user",
        userId: "alice",
        via: "session",
        workspaceId: WORKSPACE,
      },
    });
  });

  test("a person who left the org is forbidden and nothing runs", async () => {
    const t = setup();
    t.state.member = false;
    await expect(
      t.ports.calls.asMember({ ...call, userId: "alice" })
    ).rejects.toThrow("forbidden");
    expect(t.seen).toHaveLength(0);
  });

  test("a call error keeps its code, anything else reads as forbidden", async () => {
    const t = setup();
    t.state.callTool = new ArtifactCallError("not_granted", "No.");
    await expect(
      t.ports.calls.asMember({ ...call, userId: "alice" })
    ).rejects.toThrow("not_granted: No.");
    t.state.callTool = new ServiceError("not_found", "Artifact not found.");
    await expect(
      t.ports.calls.asMember({ ...call, userId: "alice" })
    ).rejects.toThrow(PREFIX.forbidden);
  });

  test("a failure of the platform's own side never shows its text to the app", async () => {
    const t = setup();
    t.state.callTool = new Error("D1_ERROR: no such table secret_table");
    await expect(
      t.ports.calls.asMember({ ...call, userId: "alice" })
    ).rejects.toThrow(PREFIX.failed);
    await expect(
      t.ports.calls.asMember({ ...call, userId: "alice" })
    ).rejects.not.toThrow("D1_ERROR");
    t.state.memberThrows = true;
    await expect(
      t.ports.calls.asMember({ ...call, userId: "alice" })
    ).rejects.toThrow(PREFIX.failed);
  });

  test("arguments that are not an object are refused", async () => {
    const t = setup();
    await expect(
      t.ports.calls.asMember({ ...call, args: [1], userId: "alice" })
    ).rejects.toThrow("object");
  });
});

describe("calls.asLink", () => {
  const meta = {
    ipPrefix: "1.2.3",
    place: "AU",
    userAgent: "ua",
    visitorHash: "vh",
  };

  test("passes the share, the call and the meta on", async () => {
    const t = setup();
    const result = await t.ports.calls.asLink({
      ...call,
      meta,
      shareId: "s1",
    });
    expect(result).toEqual({ rows: 2 });
    expect(t.seen.at(0)).toEqual({
      link: ["s1", "ar_1", { arguments: { q: "x" }, tool: "xero/list" }, meta],
    });
  });

  test("maps the refusals to the app error codes", async () => {
    const t = setup();
    const refuse = (reason: string) => {
      t.state.callShare = { ok: false, reason };
      return t.ports.calls.asLink({ ...call, meta, shareId: "s1" });
    };
    await expect(refuse("not_found")).rejects.toThrow(PREFIX.forbidden);
    await expect(refuse("forbidden")).rejects.toThrow(PREFIX.not_granted);
    await expect(refuse("rate_limited")).rejects.toThrow(PREFIX.rate_limited);
    await expect(refuse("failed")).rejects.toThrow(PREFIX.failed);
  });

  test("a failure inside the share service never shows its text to the app", async () => {
    const t = setup();
    t.state.callShareThrows = true;
    const rejected = t.ports.calls.asLink({ ...call, meta, shareId: "s1" });
    await expect(rejected).rejects.toThrow(PREFIX.failed);
    await expect(rejected).rejects.not.toThrow("D1_ERROR");
  });

  test("an empty visitor hash goes on as null", async () => {
    const t = setup();
    await t.ports.calls.asLink({
      ...call,
      meta: { ...meta, visitorHash: "" },
      shareId: "s1",
    });
    expect(JSON.stringify(t.seen.at(0))).toContain('"visitorHash":null');
  });
});
