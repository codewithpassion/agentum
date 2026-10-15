/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  assertPreviewName,
  DB_ID_PLACEHOLDER,
  DB_NAME_PLACEHOLDER,
  extractPreviewUrl,
  findDatabaseId,
  patchPreviewDb,
  previewDbName,
  trimJsonNoise,
  workerName,
} from "./preview.ts";

describe("preview helpers", () => {
  test("assertPreviewName accepts a DNS label and rejects the rest", () => {
    expect(assertPreviewName("pr-42")).toBe("pr-42");
    expect(() => assertPreviewName("PR-42")).toThrow();
    expect(() => assertPreviewName("-pr")).toThrow();
    expect(() => assertPreviewName("pr_42")).toThrow();
    expect(() => assertPreviewName("a".repeat(42))).toThrow();
  });

  test("workerName reads the top-level name, not database_name", () => {
    const config = `{
      // comment
      "name": "my-app",
      "d1_databases": [{ "database_name": "other" }]
    }`;
    expect(workerName(config)).toBe("my-app");
    expect(() => workerName("{}")).toThrow();
  });

  test("previewDbName prefixes the Worker name", () => {
    expect(previewDbName("my-app", "pr-7")).toBe("my-app-preview-pr-7");
  });

  test("trimJsonNoise drops wrangler's banner lines", () => {
    const stdout = ' ⛅️ wrangler 4.147.0\n───\nUploading...\n{\n  "a": 1\n}\n';
    expect(JSON.parse(trimJsonNoise(stdout))).toEqual({ a: 1 });
    expect(JSON.parse(trimJsonNoise("noise\n[1]"))).toEqual([1]);
    expect(() => trimJsonNoise("no json here")).toThrow();
  });

  test("extractPreviewUrl handles both output shapes", () => {
    expect(
      extractPreviewUrl({ preview_urls: ["https://a.example.workers.dev"] })
    ).toBe("https://a.example.workers.dev");
    expect(
      extractPreviewUrl({
        deployment: { urls: ["https://c.example.workers.dev"] },
        preview: { urls: ["https://b.example.workers.dev/"] },
      })
    ).toBe("https://b.example.workers.dev");
    expect(
      extractPreviewUrl({ deployment: { urls: ["https://c.example.dev"] } })
    ).toBe("https://c.example.dev");
    expect(extractPreviewUrl({ preview: { urls: [] } })).toBeNull();
    expect(extractPreviewUrl(null)).toBeNull();
  });

  test("findDatabaseId matches the exact name", () => {
    const list = JSON.stringify([
      { name: "app-preview-pr-1", uuid: "1" },
      { name: "app-preview-pr-11", uuid: "11" },
    ]);
    expect(findDatabaseId(list, "app-preview-pr-11")).toBe("11");
    expect(findDatabaseId(list, "app-preview-pr-2")).toBeNull();
  });

  test("patchPreviewDb swaps both placeholders and refuses a patched file", () => {
    const config = `{"database_name":"${DB_NAME_PLACEHOLDER}","database_id":"${DB_ID_PLACEHOLDER}"}`;
    const patched = patchPreviewDb(config, {
      databaseId: "uuid-1",
      databaseName: "app-preview-pr-1",
    });
    expect(JSON.parse(patched)).toEqual({
      database_id: "uuid-1",
      database_name: "app-preview-pr-1",
    });
    expect(() =>
      patchPreviewDb(patched, { databaseId: "x", databaseName: "y" })
    ).toThrow();
  });
});
