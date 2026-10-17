import { describe, expect, test } from "bun:test";
import {
  CLOUD_DEFAULT_ENVIRONMENT,
  CLOUD_ENVIRONMENTS,
  cloudEnvironmentError,
  cloudEnvironmentOf,
} from "./environment.ts";

describe("cloudEnvironmentOf", () => {
  test("an agent with no setting runs in the isolate", () => {
    expect(cloudEnvironmentOf({})).toBe("isolate");
    expect(CLOUD_DEFAULT_ENVIRONMENT).toBe("isolate");
  });

  test.each(CLOUD_ENVIRONMENTS.map((entry) => [entry.id] as const))(
    "reads %s from the runtime config",
    (id) => {
      expect(cloudEnvironmentOf({ environment: id })).toBe(id);
    }
  );

  test("an unknown or mistyped value falls back to the isolate", () => {
    expect(cloudEnvironmentOf({ environment: "mainframe" })).toBe("isolate");
    expect(cloudEnvironmentOf({ environment: 1 })).toBe("isolate");
  });
});

describe("cloudEnvironmentError", () => {
  test("accepts no setting and every known environment", () => {
    expect(cloudEnvironmentError({})).toBeUndefined();
    for (const entry of CLOUD_ENVIRONMENTS) {
      expect(cloudEnvironmentError({ environment: entry.id })).toBeUndefined();
    }
  });

  test("names the valid environments for anything else", () => {
    const message = cloudEnvironmentError({ environment: "mainframe" });
    expect(message).toContain('"isolate"');
    expect(message).toContain('"linux-vm"');
    expect(cloudEnvironmentError({ environment: null })).toBeDefined();
  });
});
