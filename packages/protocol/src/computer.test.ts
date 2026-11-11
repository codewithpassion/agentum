import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { file } from "bun";
import { z } from "zod";
import {
  CLIENT_ERROR_CODES,
  ClientOpRequestSchema,
  DesktopActRequestSchema,
  DesktopSnapshotRequestSchema,
  desktopAppTimeoutMs,
  HelloMessageSchema,
  isDesktopOp,
  parseDesktopActResult,
  parseDesktopAppsResult,
  parseDesktopSnapshotResult,
  RawClientReplySchema,
} from "./computer.ts";

const FIXTURE_DIR = new URL(
  "../../../apps/computer/testdata/protocol/",
  import.meta.url
);

const ERROR_CODES_FIXTURE = "error_codes.json";

const fixtureNames = (await readdir(FIXTURE_DIR)).sort();

/**
 * Meaning, not bytes. The fixtures are pretty-printed in wire order, while zod emits keys in schema
 * order, so this compares the way the Go client's round-trip test does.
 */
function asPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** The client's frames: a hello, or a reply to a request the server sent. */
function clientFrameSchema(name: string): z.ZodType | undefined {
  if (name.startsWith("client_to_server_hello")) {
    return HelloMessageSchema;
  }
  if (name.startsWith("client_to_server_reply_")) {
    return RawClientReplySchema;
  }
}

/**
 * A server request is one flat object: the envelope's `id` sits next to the op's own fields. The op
 * schema does not know about `id`, so it is read apart and put back, as the Go client does.
 */
function serverFrameAsPlainJson(raw: unknown): unknown {
  const { id } = z.object({ id: z.string().min(1) }).parse(raw);
  const body = ClientOpRequestSchema.parse(raw);
  return asPlainJson({ ...body, id });
}

describe("computer protocol fixtures", () => {
  test("the fixture folder holds error codes, client frames and server frames", () => {
    expect(fixtureNames).toContain(ERROR_CODES_FIXTURE);
    expect(
      fixtureNames.some((name) => name.startsWith("client_to_server_"))
    ).toBe(true);
    expect(
      fixtureNames.some((name) => name.startsWith("server_to_client_"))
    ).toBe(true);
  });

  test(`${ERROR_CODES_FIXTURE} equals CLIENT_ERROR_CODES`, async () => {
    const { codes } = z
      .object({ codes: z.array(z.string()) })
      .parse(await file(new URL(ERROR_CODES_FIXTURE, FIXTURE_DIR)).json());
    expect([...codes].sort()).toStrictEqual([...CLIENT_ERROR_CODES].sort());
  });

  for (const name of fixtureNames) {
    if (name === ERROR_CODES_FIXTURE) {
      continue;
    }
    test(name, async () => {
      const raw: unknown = await file(new URL(name, FIXTURE_DIR)).json();
      if (name.startsWith("client_to_server_")) {
        const schema = clientFrameSchema(name);
        if (schema === undefined) {
          throw new Error(`${name} matches no client frame schema`);
        }
        expect(asPlainJson(schema.parse(raw))).toStrictEqual(raw);
        return;
      }
      if (name.startsWith("server_to_client_")) {
        expect(serverFrameAsPlainJson(raw)).toStrictEqual(raw);
        return;
      }
      throw new Error(
        `${name} matches no frame prefix and is not ${ERROR_CODES_FIXTURE}`
      );
    });
  }
});

describe("agent-desktop ops", () => {
  const snapshot = {
    app: "chromium",
    compact: true,
    interactive: true,
    op: "desktop_snapshot",
    root: null,
    skeleton: false,
  };
  const act = {
    action: "click",
    headed: false,
    op: "desktop_act",
    ref: "@s8f3k2p9:e8",
    text: null,
  };

  test("all three take the desktop lease", () => {
    for (const op of ["desktop_snapshot", "desktop_act", "desktop_apps"]) {
      expect(isDesktopOp(op)).toBe(true);
    }
    expect(ClientOpRequestSchema.parse({ op: "desktop_apps" })).toEqual({
      op: "desktop_apps",
    });
    expect(ClientOpRequestSchema.parse(snapshot).op).toBe("desktop_snapshot");
    expect(ClientOpRequestSchema.parse(act).op).toBe("desktop_act");
  });

  test("a snapshot names one app that is a plain word and no flag", () => {
    for (const app of ["", "-x", "a;b", "a\nb", "x".repeat(65)]) {
      expect(
        DesktopSnapshotRequestSchema.safeParse({ ...snapshot, app }).success
      ).toBe(false);
    }
    expect(
      DesktopSnapshotRequestSchema.safeParse({
        ...snapshot,
        app: "Google Chrome",
      }).success
    ).toBe(true);
    expect(
      DesktopSnapshotRequestSchema.safeParse({ ...snapshot, root: "@sabc:e3" })
        .success
    ).toBe(true);
    expect(
      DesktopSnapshotRequestSchema.safeParse({ ...snapshot, root: "--help" })
        .success
    ).toBe(false);
  });

  test("an act takes a ref and a listed action, with text only where it belongs", () => {
    for (const bad of [
      { ...act, ref: "@e8" },
      { ...act, ref: "@s1:e1; id" },
      { ...act, action: "close-app" },
      { ...act, text: "x" },
      { ...act, action: "type", text: null },
      { ...act, action: "type", text: "" },
      { ...act, action: "type", text: "x".repeat(513) },
    ]) {
      expect(DesktopActRequestSchema.safeParse(bad).success).toBe(false);
    }
    for (const good of [
      act,
      { ...act, action: "type", headed: true, text: "Ada" },
      { ...act, action: "select", text: "Large" },
    ]) {
      expect(DesktopActRequestSchema.safeParse(good).success).toBe(true);
    }
  });

  test("typing gets more time, and the other ops a fixed time", () => {
    const quiet = desktopAppTimeoutMs(DesktopActRequestSchema.parse(act));
    const typed = desktopAppTimeoutMs(
      DesktopActRequestSchema.parse({
        ...act,
        action: "type",
        text: "x".repeat(100),
      })
    );
    expect(typed).toBe(quiet + 3000);
    expect(desktopAppTimeoutMs({ op: "desktop_apps" })).toBeGreaterThan(0);
    expect(
      desktopAppTimeoutMs(DesktopSnapshotRequestSchema.parse(snapshot))
    ).toBeGreaterThan(0);
  });

  test("replies parse, and a malformed one is undefined", () => {
    expect(
      parseDesktopSnapshotResult(
        JSON.stringify({
          complete: true,
          ref_count: 2,
          snapshot_id: "s1",
          text: "{}",
        })
      )?.snapshot_id
    ).toBe("s1");
    expect(parseDesktopSnapshotResult("{}")).toBeUndefined();
    expect(
      parseDesktopActResult(
        JSON.stringify({ app: "chromium", ok: true, text: "{}" })
      )?.app
    ).toBe("chromium");
    expect(
      parseDesktopAppsResult(JSON.stringify({ apps: [{ name: "chromium" }] }))
        ?.apps
    ).toHaveLength(1);
    expect(parseDesktopAppsResult("nope")).toBeUndefined();
  });

  test("a hello may report agent_desktop, and one that does not still parses", () => {
    const base = {
      arch: "amd64",
      capabilities: { git: true, python3: true },
      hostname: "box",
      os: "linux",
      protocol_version: 1,
      run_as_user: "agentum",
      type: "hello",
      version: "agentum-rs@1",
      workdir: "/var/lib/agentum/work",
    };
    expect(
      HelloMessageSchema.parse(base).capabilities.agent_desktop
    ).toBeUndefined();
    expect(
      HelloMessageSchema.parse({
        ...base,
        capabilities: {
          ...base.capabilities,
          agent_desktop: true,
          desktop: true,
        },
      }).capabilities.agent_desktop
    ).toBe(true);
  });
});
