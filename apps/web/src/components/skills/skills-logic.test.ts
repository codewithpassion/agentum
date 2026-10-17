import { expect, test } from "bun:test";
import {
  authorLabel,
  ownerLabel,
  statusLabel,
  versionLabel,
} from "./skills-logic.ts";

const names = new Map([["a1", "Pelican"]]);

test("ownerLabel names people, a known agent and an unknown one", () => {
  expect(ownerLabel(null, names)).toBe("People");
  expect(ownerLabel("a1", names)).toBe("Pelican");
  expect(ownerLabel("gone", names)).toBe("Unknown agent");
});

test("authorLabel names the agent and the run", () => {
  expect(authorLabel({ id: "u1", kind: "user", runId: null }, names)).toBe(
    "A person"
  );
  expect(
    authorLabel({ id: "a1", kind: "agent", runId: "run_0123456789" }, names)
  ).toBe("Pelican, run 23456789");
  expect(authorLabel({ id: "a1", kind: "agent", runId: null }, names)).toBe(
    "Pelican"
  );
  expect(authorLabel({ id: "s", kind: "system", runId: null }, names)).toBe(
    "Library migration"
  );
});

test("statusLabel and versionLabel", () => {
  expect(statusLabel("proposed")).toBe("Pending review");
  expect(statusLabel("approved")).toBe("Approved");
  expect(statusLabel("rejected")).toBe("Rejected");
  expect(versionLabel(3)).toBe("v3");
  expect(versionLabel(3, true)).toBe("v3 (pinned)");
});
