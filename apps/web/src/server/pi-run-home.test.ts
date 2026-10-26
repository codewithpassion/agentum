import { describe, expect, test } from "bun:test";
import { ServiceError } from "@repo/services/errors";
import { prepareHome } from "./pi-run-home.ts";

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
