/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import {
  clerkEnvFor,
  insertSql,
  parseArgs,
  selectSql,
  wranglerTarget,
} from "./add-workspace-helpers.ts";

describe("parseArgs", () => {
  test("reads a local run", () => {
    expect(
      parseArgs(["--org", "org_abc123", "--name", "Acme Co", "--local"])
    ).toEqual({
      env: undefined,
      name: "Acme Co",
      orgId: "org_abc123",
      remote: false,
    });
  });

  test("reads a remote staging run", () => {
    expect(
      parseArgs([
        "--org",
        "org_abc123",
        "--name",
        "Acme",
        "--remote",
        "--env",
        "staging",
      ])
    ).toMatchObject({ env: "staging", remote: true });
  });

  test("needs an org id shaped like Clerk's", () => {
    expect(() => parseArgs(["--name", "A", "--local"])).toThrow("--org");
    expect(() => parseArgs(["--org", "abc", "--name", "A", "--local"])).toThrow(
      "--org"
    );
    expect(() =>
      parseArgs(["--org", "org_a'; DROP", "--name", "A", "--local"])
    ).toThrow("--org");
  });

  test("needs a name", () => {
    expect(() => parseArgs(["--org", "org_a", "--local"])).toThrow("--name");
    expect(() =>
      parseArgs(["--org", "org_a", "--name", "  ", "--local"])
    ).toThrow("--name");
  });

  test("needs exactly one of --local and --remote", () => {
    expect(() => parseArgs(["--org", "org_a", "--name", "A"])).toThrow(
      "exactly one"
    );
    expect(() =>
      parseArgs(["--org", "org_a", "--name", "A", "--local", "--remote"])
    ).toThrow("exactly one");
  });

  test("--env needs --remote and only allows staging", () => {
    expect(() =>
      parseArgs([
        "--org",
        "org_a",
        "--name",
        "A",
        "--local",
        "--env",
        "staging",
      ])
    ).toThrow("--env only applies with --remote");
    expect(() =>
      parseArgs(["--org", "org_a", "--name", "A", "--remote", "--env", "prod"])
    ).toThrow("Invalid --env");
  });

  test("rejects an unknown flag and a flag with no value", () => {
    expect(() => parseArgs(["--verbose"])).toThrow("Unknown flag");
    expect(() => parseArgs(["--org"])).toThrow("Missing value for --org");
  });
});

describe("targets", () => {
  const base = { name: "A", orgId: "org_a" };

  test("wranglerTarget picks the database", () => {
    expect(wranglerTarget({ ...base, env: undefined, remote: false })).toEqual([
      "--local",
    ]);
    expect(wranglerTarget({ ...base, env: undefined, remote: true })).toEqual([
      "--remote",
    ]);
    expect(wranglerTarget({ ...base, env: "staging", remote: true })).toEqual([
      "--remote",
      "--env",
      "staging",
    ]);
  });

  test("clerkEnvFor names the Clerk instance", () => {
    expect(clerkEnvFor({ ...base, env: undefined, remote: false })).toBe(
      "local"
    );
    expect(clerkEnvFor({ ...base, env: "staging", remote: true })).toBe(
      "staging"
    );
    expect(clerkEnvFor({ ...base, env: undefined, remote: true })).toBe(
      "production"
    );
  });
});

describe("sql", () => {
  const input = {
    createdAt: "2026-11-02T00:00:00.000Z",
    id: "01TESTID",
    name: "O'Brien & Co",
    orgId: "org_abc123",
  };

  test("insertSql makes one row, and a second run changes nothing", () => {
    const db = migrated();
    db.client.run(insertSql(input));
    db.client.run(insertSql({ ...input, id: "01OTHER", name: "Renamed" }));
    const rows = db.client.query(`${selectSql("org_abc123")}`).all();
    expect(rows).toEqual([{ id: "01TESTID", name: "O'Brien & Co" }]);
  });

  test("selectSql quotes the org id", () => {
    expect(selectSql("org_a")).toContain("'org_a'");
  });
});
