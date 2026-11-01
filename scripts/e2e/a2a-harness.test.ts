import { expect, test } from "bun:test";
import { thirdPartyEnv } from "./a2a-harness.ts";

test("third-party code gets the shell basics and what the caller adds, and no keys", () => {
  const saved = { ...process.env };
  const touched = [
    "OPENROUTER_API_KEY",
    "CLERK_SECRET_KEY",
    "ANTHROPIC_API_KEY",
    "LC_ALL",
  ];
  process.env.OPENROUTER_API_KEY = "sk-secret";
  process.env.CLERK_SECRET_KEY = "sk_secret";
  process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
  process.env.LC_ALL = "C";
  try {
    const env = thirdPartyEnv({ HERMES_HOME: "/tmp/h", HOME: "/tmp/h/home" });
    expect(env.PATH).toBe(process.env.PATH ?? "");
    expect(env.LC_ALL).toBe("C");
    expect(env.HERMES_HOME).toBe("/tmp/h");
    expect(env.HOME).toBe("/tmp/h/home");
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(Object.keys(env).some((name) => name.endsWith("_KEY"))).toBe(false);
  } finally {
    for (const name of touched) {
      const before = saved[name];
      if (before === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = before;
      }
    }
  }
});

test("the caller's own values win over the shell's", () => {
  expect(thirdPartyEnv({ PATH: "/only" }).PATH).toBe("/only");
});
