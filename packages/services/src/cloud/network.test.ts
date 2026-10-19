import { describe, expect, test } from "bun:test";
import {
  CLOUD_NETWORK_KEY,
  networkAccessError,
  networkAccessOf,
} from "./network.ts";

describe("networkAccessOf", () => {
  test("an agent with no setting has network access", () => {
    expect(networkAccessOf({})).toBe(true);
    expect(CLOUD_NETWORK_KEY).toBe("networkAccess");
  });

  test("true has network access and false does not", () => {
    expect(networkAccessOf({ networkAccess: true })).toBe(true);
    expect(networkAccessOf({ networkAccess: false })).toBe(false);
  });

  test.each([["no"], [0], [null], ["false"]])(
    "a junk value %p keeps network access",
    (value) => {
      expect(networkAccessOf({ networkAccess: value })).toBe(true);
    }
  );
});

describe("networkAccessError", () => {
  test("accepts no setting and both booleans", () => {
    expect(networkAccessError({})).toBeUndefined();
    expect(networkAccessError({ networkAccess: true })).toBeUndefined();
    expect(networkAccessError({ networkAccess: false })).toBeUndefined();
  });

  test.each([["no"], [0], [null], ["false"]])(
    "a non-boolean %p is an error",
    (value) => {
      expect(networkAccessError({ networkAccess: value })).toBeDefined();
    }
  );
});
