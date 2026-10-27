import { expect, test } from "bun:test";
import { scrollBehaviorFor } from "./reply-bar.tsx";

test("scrolls smoothly unless the person asks for reduced motion", () => {
  expect(scrollBehaviorFor(false)).toBe("smooth");
  expect(scrollBehaviorFor(true)).toBe("auto");
});
