import { describe, expect, test } from "bun:test";
import { maskMcpUrl } from "./format";

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
