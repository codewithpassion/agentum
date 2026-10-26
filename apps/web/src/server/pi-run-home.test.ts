import { describe, expect, test } from "bun:test";
import { ServiceError } from "@repo/services/errors";
import type { LibraryOps } from "./library-bash/library-fs.ts";
import { prepareHome, withMissingHomeEmpty } from "./pi-run-home.ts";

/** A library with no folders, which records every call that writes. */
const fakeLibrary = () => {
  const writes: string[] = [];
  const notFound = () =>
    Promise.reject(new ServiceError("not_found", "Not found"));
  const ops = {
    list: notFound,
    mkdir: (path: string) => {
      writes.push(`mkdir ${path}`);
      return Promise.resolve();
    },
    stat: notFound,
    write: (path: string) => {
      writes.push(`write ${path}`);
      return Promise.resolve();
    },
  };
  return { ops, writes };
};

describe("prepareHome", () => {
  test("a normal run makes the agent's home", async () => {
    const { ops, writes } = fakeLibrary();

    await prepareHome(ops, "pelican", false);

    expect(writes).toEqual(["mkdir agents/pelican"]);
  });

  test("a dry run makes no folder and writes nothing", async () => {
    const { ops, writes } = fakeLibrary();

    await prepareHome(ops, "pelican", true);

    expect(writes).toEqual([]);
  });
});

describe("withMissingHomeEmpty", () => {
  const listed = (dryRun: boolean, dir: string) => {
    const { ops, writes } = fakeLibrary();
    const bound = withMissingHomeEmpty(
      ops as unknown as LibraryOps,
      "pelican",
      dryRun
    );
    return { result: bound.list(dir), writes };
  };

  test("a dry run lists a missing home as empty and writes nothing", async () => {
    const { result, writes } = listed(true, "agents/pelican");

    expect(await result).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("a dry run still fails for any other missing folder", async () => {
    const { result } = listed(true, "agents/other");

    await expect(result).rejects.toThrow("Not found");
  });

  test("a normal run keeps the not found answer", async () => {
    const { result } = listed(false, "agents/pelican");

    await expect(result).rejects.toThrow("Not found");
  });
});
