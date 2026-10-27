import { expect, test } from "bun:test";
import {
  pinMenuLabel,
  pinnedSurfaces,
  pinToast,
  togglePinned,
} from "./viewer-menu-model.ts";

test("pinnedSurfaces keeps only this artifact's surfaces", () => {
  const pins = [
    { artifactId: "a1", surface: "sidebar" as const },
    { artifactId: "a2", surface: "desk" as const },
  ];
  expect([...pinnedSurfaces(pins, "a1")]).toEqual(["sidebar"]);
  expect(pinnedSurfaces([], "a1").size).toBe(0);
});

test("pinMenuLabel flips with the pinned state", () => {
  expect(pinMenuLabel("sidebar", false)).toBe("Pin to sidebar");
  expect(pinMenuLabel("sidebar", true)).toBe("Unpin from sidebar");
  expect(pinMenuLabel("desk", false)).toBe("Pin to desk");
  expect(pinMenuLabel("desk", true)).toBe("Unpin from desk");
});

test("togglePinned adds or removes one surface without touching the input", () => {
  const start = new Set<"desk" | "sidebar">(["desk"]);
  const added = togglePinned(start, "sidebar");
  expect([...added].sort()).toEqual(["desk", "sidebar"]);
  expect([...start]).toEqual(["desk"]);
  expect([...togglePinned(added, "desk")]).toEqual(["sidebar"]);
});

test("pinToast names the new state", () => {
  expect(pinToast("sidebar", true)).toBe("Pinned to sidebar");
  expect(pinToast("desk", false)).toBe("Unpinned from desk");
});
