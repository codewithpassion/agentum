import { describe, expect, test } from "bun:test";
import { hostsOf, toggledIds } from "./grants.ts";

describe("toggledIds", () => {
  test("adds a secret that is not granted yet", () => {
    expect(toggledIds(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
  });

  test("removes a granted secret and keeps the others", () => {
    expect(toggledIds(["a", "b", "c"], "b", false)).toEqual(["a", "c"]);
  });

  test("granting twice does not duplicate the id", () => {
    expect(toggledIds(["a"], "a", true)).toEqual(["a"]);
  });

  test("revoking a secret that is not granted changes nothing", () => {
    expect(toggledIds(["a"], "b", false)).toEqual(["a"]);
  });

  test("does not change the input array", () => {
    const current = ["a"];
    toggledIds(current, "b", true);
    expect(current).toEqual(["a"]);
  });
});

describe("hostsOf", () => {
  test("lists each host once, in order", () => {
    expect(
      hostsOf([
        { host: "api.example.com" },
        { host: "*.example.org" },
        { host: "api.example.com" },
      ])
    ).toEqual(["api.example.com", "*.example.org"]);
  });

  test("is empty when there are no rules", () => {
    expect(hostsOf([])).toEqual([]);
  });
});
