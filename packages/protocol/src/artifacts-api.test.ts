import { describe, expect, test } from "bun:test";
import {
  artifactsCallToolInputSchema,
  artifactsCreateShareInputSchema,
  artifactsDecideGrantInputSchema,
  artifactsGetInputSchema,
  artifactsHandToInputSchema,
  artifactsListInputSchema,
  artifactsOpenInputSchema,
  artifactsPinInputSchema,
  artifactsPromoteInputSchema,
  artifactsRemoveInputSchema,
  artifactsRenameInputSchema,
  artifactsRestoreInputSchema,
  artifactsRevokeShareInputSchema,
  artifactsSetAudienceInputSchema,
  artifactsSetLinksEnabledInputSchema,
  artifactsSharesInputSchema,
  artifactsUnpinInputSchema,
  artifactsVersionsInputSchema,
  artifactsViewsInputSchema,
  artifactThreadPartSchema,
  artifactViewSchema,
  SHARE_UNAVAILABLE_MESSAGE,
  shareCallErrorSchema,
  shareCallInputSchema,
  shareCallResponseSchema,
  shareOpenResponseSchema,
  shareUnavailableSchema,
} from "./artifacts.ts";

const id = "2f6c1c5e-8a52-4f6e-9d57-3f2a7d9b1c10";
const now = "2026-10-27T10:00:00.000Z";

const cases: [
  string,
  { safeParse: (v: unknown) => { success: boolean } },
  unknown,
  unknown,
][] = [
  [
    "list",
    artifactsListInputSchema,
    { kind: "page", madeBy: "agent", shared: true },
    { kind: "video" },
  ],
  ["get", artifactsGetInputSchema, { artifactId: id }, { artifactId: "nope" }],
  ["versions", artifactsVersionsInputSchema, { artifactId: id }, {}],
  [
    "restore",
    artifactsRestoreInputSchema,
    { artifactId: id, version: 2 },
    { artifactId: id, version: 1.5 },
  ],
  [
    "rename",
    artifactsRenameInputSchema,
    { artifactId: id, title: "Q3" },
    { artifactId: id, title: "" },
  ],
  [
    "setAudience",
    artifactsSetAudienceInputSchema,
    { artifactId: id, audience: "workspace" },
    { artifactId: id, audience: "public" },
  ],
  [
    "remove",
    artifactsRemoveInputSchema,
    { artifactId: id },
    { artifactId: "x" },
  ],
  [
    "promote",
    artifactsPromoteInputSchema,
    { artifactId: id, versionId: "v1" },
    { artifactId: id, versionId: "" },
  ],
  [
    "decideGrant",
    artifactsDecideGrantInputSchema,
    { decision: "approved", grantId: "g1" },
    { decision: "maybe", grantId: "g1" },
  ],
  [
    "callTool",
    artifactsCallToolInputSchema,
    { arguments: { a: 1 }, artifactId: id, tool: "crm/list", versionId: "v1" },
    { artifactId: id, versionId: "v1" },
  ],
  [
    "pin",
    artifactsPinInputSchema,
    { artifactId: id, surface: "desk" },
    { artifactId: id, surface: "top" },
  ],
  [
    "unpin",
    artifactsUnpinInputSchema,
    { artifactId: id, surface: "sidebar" },
    { artifactId: id },
  ],
  [
    "handTo",
    artifactsHandToInputSchema,
    { agentId: null, artifactId: id },
    { artifactId: id },
  ],
  [
    "open",
    artifactsOpenInputSchema,
    { artifactId: id, surface: "viewer", version: 3 },
    { artifactId: id, surface: "share" },
  ],
  [
    "shares",
    artifactsSharesInputSchema,
    { artifactId: id },
    { artifactId: "x" },
  ],
  [
    "revokeShare",
    artifactsRevokeShareInputSchema,
    { shareId: "s1" },
    { shareId: "" },
  ],
  [
    "views",
    artifactsViewsInputSchema,
    { artifactId: id, cursor: "c", shareId: "s1" },
    { artifactId: "x" },
  ],
  [
    "setLinksEnabled",
    artifactsSetLinksEnabledInputSchema,
    { enabled: false },
    { enabled: "no" },
  ],
];

describe("input schemas", () => {
  test.each(cases)("%s accepts a valid value", (_name, schema, good) => {
    expect(schema.safeParse(good).success).toBe(true);
  });

  test.each(cases)(
    "%s rejects an invalid value",
    (_name, schema, _good, bad) => {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  );

  test("rename rejects a title over 120 characters", () => {
    expect(
      artifactsRenameInputSchema.safeParse({
        artifactId: id,
        title: "a".repeat(121),
      }).success
    ).toBe(false);
    expect(
      artifactsRenameInputSchema.safeParse({
        artifactId: id,
        title: "a".repeat(120),
      }).success
    ).toBe(true);
  });
});

describe("artifactsCreateShareInputSchema", () => {
  test("defaults to a snapshot link", () => {
    const parsed = artifactsCreateShareInputSchema.parse({ artifactId: id });
    expect(parsed.dataMode).toBe("snapshot");
  });

  test("accepts a live link with tools", () => {
    expect(
      artifactsCreateShareInputSchema.safeParse({
        artifactId: id,
        dataMode: "live",
        expiresAt: now,
        liveTools: ["crm/list"],
        versionId: null,
      }).success
    ).toBe(true);
  });

  test("rejects liveTools on a snapshot link", () => {
    expect(
      artifactsCreateShareInputSchema.safeParse({
        artifactId: id,
        dataMode: "snapshot",
        liveTools: ["crm/list"],
      }).success
    ).toBe(false);
    expect(
      artifactsCreateShareInputSchema.safeParse({
        artifactId: id,
        liveTools: ["crm/list"],
      }).success
    ).toBe(false);
  });

  test("rejects a live link without tools", () => {
    expect(
      artifactsCreateShareInputSchema.safeParse({
        artifactId: id,
        dataMode: "live",
      }).success
    ).toBe(false);
    expect(
      artifactsCreateShareInputSchema.safeParse({
        artifactId: id,
        dataMode: "live",
        liveTools: [],
      }).success
    ).toBe(false);
  });
});

describe("artifactThreadPartSchema", () => {
  test("parses the part the fold emits", () => {
    expect(
      artifactThreadPartSchema.safeParse({
        artifactId: id,
        kind: "page",
        title: "Report",
        toolCallId: null,
        type: "artifact",
        version: 1,
        versionId: "v1",
      }).success
    ).toBe(true);
  });
});

describe("artifactViewSchema", () => {
  const view = {
    artifactId: id,
    asn: null,
    asOrg: null,
    city: null,
    country: "AU",
    createdAt: now,
    id: "w1",
    ipPrefix: "203.0.113.0/24",
    outcome: "ok",
    referrerHost: null,
    region: null,
    shareId: "s1",
    surface: "share",
    toolKey: null,
    userAgent: null,
    userId: null,
    versionId: "v1",
  };

  test("parses a row", () => {
    expect(artifactViewSchema.safeParse(view).success).toBe(true);
  });

  test("rejects a visitorHash key", () => {
    expect(
      artifactViewSchema.safeParse({ ...view, visitorHash: "abc" }).success
    ).toBe(false);
  });
});

describe("share HTTP schemas", () => {
  test("parses the open response", () => {
    expect(
      shareOpenResponseSchema.safeParse({
        agentName: null,
        contentUrl: "https://content.example/x",
        expiresAt: now,
        kind: "doc",
        ownerName: "Dom",
        title: "Plan",
        version: { createdAt: now, number: 2 },
        workspaceName: "Acme",
      }).success
    ).toBe(true);
  });

  test("unavailable carries the fixed message only", () => {
    expect(
      shareUnavailableSchema.safeParse({ error: SHARE_UNAVAILABLE_MESSAGE })
        .success
    ).toBe(true);
    expect(shareUnavailableSchema.safeParse({ error: "Revoked" }).success).toBe(
      false
    );
  });

  test("call input, response and error", () => {
    expect(
      shareCallInputSchema.safeParse({ arguments: {}, tool: "crm/list" })
        .success
    ).toBe(true);
    expect(shareCallInputSchema.safeParse({ arguments: {} }).success).toBe(
      false
    );
    expect(shareCallResponseSchema.safeParse({ result: [1] }).success).toBe(
      true
    );
    expect(shareCallErrorSchema.safeParse({ error: "nope" }).success).toBe(
      true
    );
  });
});
