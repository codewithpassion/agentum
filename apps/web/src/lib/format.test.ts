import { describe, expect, test } from "bun:test";
import { formatRelativeTime, maskMcpUrl } from "./format";

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 7, 20, 12, 0, 0);
  const ago = (ms: number) => formatRelativeTime(now - ms, now);

  test("counts up through the units", () => {
    expect(ago(5000)).toBe("just now");
    expect(ago(3 * 60_000)).toBe("3m ago");
    expect(ago(2 * 3_600_000)).toBe("2h ago");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
  });

  test("falls back to a date past a week", () => {
    expect(ago(9 * 86_400_000)).not.toContain("ago");
  });
});

describe("maskMcpUrl", () => {
  test("hides the token but keeps the endpoint recognisable", () => {
    expect(maskMcpUrl("https://app.example.com/mcp/s3cret-token")).toBe(
      "https://app.example.com/mcp/••••••••"
    );
  });

  test("masks everything when there is no path to keep", () => {
    expect(maskMcpUrl("token-only")).toBe("••••••••");
  });
});
