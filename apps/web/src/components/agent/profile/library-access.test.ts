import { describe, expect, test } from "bun:test";
import {
  folderPaths,
  modeLabel,
  otherMode,
  splitFolders,
} from "./library-access.ts";

describe("splitFolders", () => {
  const home = { access: "write", home: true, path: "agents/sorter" } as const;
  const wiki = { access: "read", home: false, path: "wiki" } as const;
  const grant = { access: "read", home: false, path: "finance" } as const;

  test("separates home, wiki and grants", () => {
    expect(splitFolders([home, wiki, grant])).toEqual({
      grants: [grant],
      home,
      wiki,
    });
  });

  test("keeps every grant when there is no wiki row", () => {
    expect(splitFolders([home, grant]).grants).toEqual([grant]);
  });
});

describe("otherMode", () => {
  test("flips read and write", () => {
    expect(otherMode("read")).toBe("write");
    expect(otherMode("write")).toBe("read");
  });
});

describe("modeLabel", () => {
  test("names each mode", () => {
    expect(modeLabel("read")).toBe("Read only");
    expect(modeLabel("write")).toBe("Read and write");
  });
});

describe("folderPaths", () => {
  test("keeps the folders and drops the files", () => {
    expect(
      folderPaths([
        { kind: "dir", path: "finance" },
        { kind: "file", path: "a.md" },
      ])
    ).toEqual(["finance"]);
  });
});
