import { expect, test } from "bun:test";
import { secretsGuidance } from "./guidance.ts";

const BASE = "https://hm.example/";

test("a run with no secrets gets no guidance", () => {
  expect(
    secretsGuidance({ base: BASE, env: [], proxy: [], surface: "machine" })
  ).toBe("");
});

test("env names and relay addresses are named, never a value", () => {
  const text = secretsGuidance({
    base: BASE,
    env: ["PLAIN_KEY"],
    proxy: [{ hosts: ["api.openai.com", "*.example.com"], name: "K" }],
    surface: "machine",
  });
  expect(text).toContain("PLAIN_KEY");
  expect(text).toContain("https://hm.example/api/egress/api.openai.com/<path>");
  expect(text).toContain("HARBOURMASTER_RELAY_TOKEN");
});

test("a wildcard host asks for the complete host", () => {
  const text = secretsGuidance({
    base: BASE,
    env: [],
    proxy: [{ hosts: ["*.example.com"], name: "K" }],
    surface: "managed",
  });
  expect(text).toContain("<full-host>");
  expect(text).toContain("a.example.com");
});

test("a managed agent is told its variables are placeholders", () => {
  const text = secretsGuidance({
    base: BASE,
    env: ["PLAIN_KEY"],
    proxy: [],
    surface: "managed",
  });
  expect(text).toContain("placeholder");
});
