import { expect, test } from "bun:test";
import { approvalSeen } from "./approval-seen.ts";

const base = {
  peerOrigin: "https://a.example",
  pendingOrigin: null,
  pendingTokenUrl: null,
  tokenUrl: null,
};

test("a stored origin is what was seen when nothing moved", () => {
  expect(approvalSeen(base)).toEqual({
    origin: "https://a.example",
    tokenUrl: null,
  });
});

test("a card that moved shows its new origin and token URL", () => {
  expect(
    approvalSeen({
      ...base,
      pendingOrigin: "https://b.example",
      pendingTokenUrl: "https://b.example/token",
      tokenUrl: "https://a.example/token",
    })
  ).toEqual({
    origin: "https://b.example",
    tokenUrl: "https://b.example/token",
  });
});

test("a stored token URL stays when only the origin moved", () => {
  expect(
    approvalSeen({
      ...base,
      pendingOrigin: "https://b.example",
      tokenUrl: "https://a.example/token",
    })
  ).toEqual({
    origin: "https://b.example",
    tokenUrl: "https://a.example/token",
  });
});

test("no origin means nothing to approve", () => {
  expect(approvalSeen({ ...base, peerOrigin: null })).toBeNull();
});
