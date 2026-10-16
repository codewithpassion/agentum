/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  baseUrlFor,
  parseArgs,
  parseEnvFile,
  redirectUrlFor,
  resolveSecretKey,
} from "./agent-login-helpers.ts";

const DEV_KEY = "sk_test_dev_key_value";
const PROD_KEY = "sk_live_prod_key_value";

const noKeys = {};

describe("parseArgs", () => {
  test("defaults to local, redirect /, no pr, email or base url", () => {
    expect(parseArgs([])).toEqual({
      baseUrl: undefined,
      email: undefined,
      env: "local",
      pr: undefined,
      redirect: "/",
    });
  });

  test("reads every flag", () => {
    expect(
      parseArgs([
        "--env",
        "preview",
        "--pr",
        "12",
        "--email",
        "a@b.co",
        "--redirect",
        "/tasks",
        "--base-url",
        "http://x.test",
      ])
    ).toEqual({
      baseUrl: "http://x.test",
      email: "a@b.co",
      env: "preview",
      pr: 12,
      redirect: "/tasks",
    });
  });

  test("rejects an invalid env", () => {
    expect(() => parseArgs(["--env", "prod"])).toThrow("Invalid --env prod");
  });

  test("rejects an unknown flag", () => {
    expect(() => parseArgs(["--verbose"])).toThrow("Unknown flag");
    expect(() => parseArgs(["stray"])).toThrow("Unknown flag");
  });

  test("rejects a flag with no value", () => {
    expect(() => parseArgs(["--email"])).toThrow("Missing value for --email");
    expect(() => parseArgs(["--env", "--pr", "3"])).toThrow(
      "Missing value for --env"
    );
    expect(() => parseArgs(["--base-url", ""])).toThrow(
      "Missing value for --base-url"
    );
  });

  test("rejects an invalid --pr", () => {
    for (const bad of ["0", "-3", "1.5", "abc", "12x", "1e3"]) {
      expect(() => parseArgs(["--env", "preview", "--pr", bad])).toThrow(
        "Invalid --pr"
      );
    }
  });

  test("requires --pr for preview", () => {
    expect(() => parseArgs(["--env", "preview"])).toThrow(
      "needs --pr <number>"
    );
  });

  test("rejects --pr for a non-preview env", () => {
    expect(() => parseArgs(["--pr", "4"])).toThrow(
      "only applies to --env preview"
    );
    expect(() => parseArgs(["--env", "staging", "--pr", "4"])).toThrow(
      "only applies to --env preview"
    );
  });

  test("rejects a redirect that does not start with a slash", () => {
    expect(() => parseArgs(["--redirect", "tasks"])).toThrow(
      'must start with "/"'
    );
    expect(() => parseArgs(["--redirect", "https://x.test/"])).toThrow(
      'must start with "/"'
    );
  });
});

describe("baseUrlFor", () => {
  test("local", () => {
    expect(baseUrlFor(parseArgs([]))).toBe("http://localhost:3000");
  });

  test("staging", () => {
    expect(baseUrlFor(parseArgs(["--env", "staging"]))).toBe(
      "https://harbourmaster-staging.rockyshoreslabs.io"
    );
  });

  test("preview uses the PR number", () => {
    expect(baseUrlFor(parseArgs(["--env", "preview", "--pr", "12"]))).toBe(
      "https://pr-12-harbourmaster-staging.dominik-fretz.workers.dev"
    );
  });

  test("production", () => {
    expect(baseUrlFor(parseArgs(["--env", "production"]))).toBe(
      "https://harbourmaster.rockyshoreslabs.io"
    );
  });

  test("--base-url overrides any env and strips trailing slashes", () => {
    expect(
      baseUrlFor(
        parseArgs(["--env", "production", "--base-url", "http://x.test/"])
      )
    ).toBe("http://x.test");
    expect(baseUrlFor(parseArgs(["--base-url", "http://x.test//"]))).toBe(
      "http://x.test"
    );
  });
});

describe("redirectUrlFor", () => {
  test("joins base URL and redirect path", () => {
    expect(redirectUrlFor(parseArgs([]))).toBe("http://localhost:3000/");
    expect(
      redirectUrlFor(parseArgs(["--env", "staging", "--redirect", "/tasks/1"]))
    ).toBe("https://harbourmaster-staging.rockyshoreslabs.io/tasks/1");
    expect(
      redirectUrlFor(
        parseArgs(["--base-url", "http://x.test/", "--redirect", "/a"])
      )
    ).toBe("http://x.test/a");
  });
});

describe("parseEnvFile", () => {
  test("reads KEY=VALUE and skips blanks and comments", () => {
    const text = [
      "# a comment",
      "",
      "CLERK_SECRET_KEY=sk_one",
      "   # indented comment",
      "OTHER=two",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      CLERK_SECRET_KEY: "sk_one",
      OTHER: "two",
    });
  });

  test("strips one matching pair of single or double quotes", () => {
    const text = [
      `DOUBLE="quoted value"`,
      `SINGLE='single value'`,
      `MISMATCH="open only`,
      `TINY="`,
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      DOUBLE: "quoted value",
      MISMATCH: `"open only`,
      SINGLE: "single value",
      TINY: `"`,
    });
  });

  test("splits on the first = only", () => {
    expect(parseEnvFile("URL=https://x.test/?a=1&b=2")).toEqual({
      URL: "https://x.test/?a=1&b=2",
    });
    expect(parseEnvFile("PAD=abc==")).toEqual({ PAD: "abc==" });
  });

  test("trims keys and values and handles CRLF", () => {
    expect(parseEnvFile("  KEY  =  value  \r\nNEXT=1\r\n")).toEqual({
      KEY: "value",
      NEXT: "1",
    });
  });

  test("ignores lines without = and empty keys", () => {
    expect(parseEnvFile("junk\n=novalue\nOK=1")).toEqual({ OK: "1" });
  });
});

describe("resolveSecretKey", () => {
  const devOnly = {
    envLocal: { CLERK_SECRET_KEY: DEV_KEY },
    process: {},
    productionLocal: {},
  };

  test("local, staging and preview use the dev key from .env.local", () => {
    for (const env of ["local", "staging", "preview"] as const) {
      expect(resolveSecretKey(env, devOnly)).toBe(DEV_KEY);
    }
  });

  test("dev envs ignore the production sources", () => {
    expect(
      resolveSecretKey("staging", {
        envLocal: { CLERK_SECRET_KEY: DEV_KEY },
        process: { CLERK_SECRET_KEY: PROD_KEY },
        productionLocal: { CLERK_SECRET_KEY: PROD_KEY },
      })
    ).toBe(DEV_KEY);
  });

  test("dev envs throw when .env.local has no key, naming the file", () => {
    for (const envLocal of [
      noKeys,
      { CLERK_SECRET_KEY: "" },
      { CLERK_SECRET_KEY: "  " },
    ]) {
      expect(() =>
        resolveSecretKey("local", {
          envLocal,
          process: {},
          productionLocal: {},
        })
      ).toThrow("apps/web/.env.local");
    }
  });

  test("production uses the production file key first", () => {
    expect(
      resolveSecretKey("production", {
        envLocal: { CLERK_SECRET_KEY: DEV_KEY },
        process: { CLERK_SECRET_KEY: "sk_live_from_process" },
        productionLocal: { CLERK_SECRET_KEY: PROD_KEY },
      })
    ).toBe(PROD_KEY);
  });

  test("production falls back to a process key that differs from the dev key", () => {
    expect(
      resolveSecretKey("production", {
        envLocal: { CLERK_SECRET_KEY: DEV_KEY },
        process: { CLERK_SECRET_KEY: PROD_KEY },
        productionLocal: {},
      })
    ).toBe(PROD_KEY);
  });

  test("production ignores a process key equal to the dev key", () => {
    expect(() =>
      resolveSecretKey("production", {
        envLocal: { CLERK_SECRET_KEY: DEV_KEY },
        process: { CLERK_SECRET_KEY: DEV_KEY },
        productionLocal: {},
      })
    ).toThrow();
  });

  test("production with no usable key throws a message naming both sources", () => {
    expect(() =>
      resolveSecretKey("production", {
        envLocal: {},
        process: {},
        productionLocal: {},
      })
    ).toThrow(
      "Production needs CLERK_SECRET_KEY in apps/web/.env.production.local or in the process environment."
    );
  });

  test("errors never contain a key value", () => {
    const sources = {
      envLocal: { CLERK_SECRET_KEY: DEV_KEY },
      process: { CLERK_SECRET_KEY: DEV_KEY },
      productionLocal: {},
    };
    let message = "";
    try {
      resolveSecretKey("production", sources);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(DEV_KEY);
    expect(message).not.toContain(PROD_KEY);
  });
});
