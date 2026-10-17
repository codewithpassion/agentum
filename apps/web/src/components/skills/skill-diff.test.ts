import { expect, test } from "bun:test";
import { diffLineKind } from "./skill-diff.tsx";

test("diff lines are coloured by their first character", () => {
  expect(diffLineKind("+added line")).toBe("added");
  expect(diffLineKind("-removed line")).toBe("removed");
  expect(diffLineKind("@@ -1,2 +1,2 @@")).toBe("hunk");
  expect(diffLineKind(" context line")).toBe("plain");
  expect(diffLineKind("")).toBe("plain");
});

test("a sign only counts in the first column", () => {
  expect(diffLineKind("  +indented")).toBe("plain");
  expect(diffLineKind("text -dash")).toBe("plain");
});
