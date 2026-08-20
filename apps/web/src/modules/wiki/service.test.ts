import { describe, expect, test } from "bun:test";
import { normalizeWrite } from "./service";

describe("normalizeWrite", () => {
  test("derives the address from the title", () => {
    expect(normalizeWrite({ title: "Getting Started" })).toEqual({
      slug: "getting-started",
      title: "Getting Started",
    });
  });

  test("nests on a path title and stores only the leaf as the name", () => {
    expect(normalizeWrite({ title: "Ops/Runbooks/Deploy the App" })).toEqual({
      slug: "ops/runbooks/deploy-the-app",
      title: "Deploy the App",
    });
  });

  test("prefers an explicit slug and still leafs the title", () => {
    expect(
      normalizeWrite({ slug: "Ops/Old Address", title: "Ops/Runbooks" })
    ).toEqual({ slug: "ops/old-address", title: "Runbooks" });
  });

  test("ignores stray separators in the title", () => {
    expect(normalizeWrite({ title: "/Ops//Runbooks/" })).toEqual({
      slug: "ops/runbooks",
      title: "Runbooks",
    });
  });
});
