import { describe, expect, test } from "bun:test";
import { slugFromName } from "./service";

describe("slugFromName", () => {
  test("lowercases and dashes a workspace name", () => {
    expect(slugFromName("Acme Rockets")).toBe("acme-rockets");
    expect(slugFromName("  Acme   Rockets!  ")).toBe("acme-rockets");
    expect(slugFromName("R&D / Platform")).toBe("r-d-platform");
  });

  test("falls back when the name has nothing url-safe in it", () => {
    expect(slugFromName("???")).toBe("workspace");
    expect(slugFromName("日本語")).toBe("workspace");
  });

  test("never ends on the dash a truncated name would leave", () => {
    const slug = slugFromName(`${"a".repeat(47)} beta`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });
});
