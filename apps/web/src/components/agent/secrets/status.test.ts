import { describe, expect, test } from "bun:test";
import { secretStatus } from "./status.ts";

const isolate = { runtime: "cloud", runtimeConfig: { environment: "isolate" } };
const isolateDefault = { runtime: "cloud", runtimeConfig: {} };
const envSecret = (allowedHosts: string[]) => ({
  allowedHosts,
  mode: "env",
  rules: [],
});
const proxySecret = (hosts: string[]) => ({
  allowedHosts: [],
  mode: "proxy",
  rules: hosts.map((host) => ({ host })),
});

describe("secretStatus for an isolate agent", () => {
  test("a proxy secret works and names its hosts", () => {
    expect(secretStatus(proxySecret(["api.example.com"]), isolate)).toEqual({
      text: "proxy: added for api.example.com",
      works: true,
    });
  });

  test("an env secret with allowed hosts is a placeholder for them", () => {
    expect(
      secretStatus(envSecret(["api.example.com", "*.example.org"]), isolate)
    ).toEqual({
      text: "env: placeholder, allowed hosts api.example.com, *.example.org",
      works: true,
    });
  });

  test("an env secret without allowed hosts does not work", () => {
    expect(secretStatus(envSecret([]), isolate)).toEqual({
      text: "env: no allowed hosts, won't work here",
      works: false,
    });
  });

  test("an empty runtimeConfig is the isolate default", () => {
    expect(
      secretStatus(envSecret(["api.example.com"]), isolateDefault)
    ).toEqual({
      text: "env: placeholder, allowed hosts api.example.com",
      works: true,
    });
    expect(secretStatus(envSecret([]), isolateDefault)).toEqual({
      text: "env: no allowed hosts, won't work here",
      works: false,
    });
  });

  test("an env secret does not work when network access is off", () => {
    expect(
      secretStatus(envSecret(["api.example.com"]), {
        runtime: "cloud",
        runtimeConfig: { networkAccess: false },
      })
    ).toEqual({
      text: "env: network access is off, won't work here",
      works: false,
    });
  });

  test("a proxy secret still works when network access is off", () => {
    expect(
      secretStatus(proxySecret(["api.example.com"]), {
        runtime: "cloud",
        runtimeConfig: { networkAccess: false },
      })
    ).toEqual({
      text: "proxy: added for api.example.com",
      works: true,
    });
  });

  test("a proxy secret with two rules on one host lists the host once", () => {
    expect(
      secretStatus(
        {
          allowedHosts: [],
          mode: "proxy",
          rules: [{ host: "api.example.com" }, { host: "api.example.com" }],
        },
        isolate
      )
    ).toEqual({
      text: "proxy: added for api.example.com",
      works: true,
    });
  });
});

describe("secretStatus outside isolate agents", () => {
  test("is null for a linux-vm agent", () => {
    expect(
      secretStatus(envSecret(["api.example.com"]), {
        runtime: "cloud",
        runtimeConfig: { environment: "linux-vm" },
      })
    ).toBeNull();
  });

  test("is null for a machine agent", () => {
    expect(
      secretStatus(envSecret(["api.example.com"]), {
        runtime: "machine",
        runtimeConfig: {},
      })
    ).toBeNull();
  });

  test("is null for a managed agent", () => {
    expect(
      secretStatus(proxySecret(["api.example.com"]), {
        runtime: "managed",
        runtimeConfig: {},
      })
    ).toBeNull();
  });
});
