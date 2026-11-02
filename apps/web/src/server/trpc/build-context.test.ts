import { expect, test } from "bun:test";
import type { Composed } from "../compose.ts";
import { buildContext } from "./build-context.ts";

const composedWith = (
  sessionPrincipal: (input: unknown) => Promise<null>
): Composed =>
  ({ services: { workspaces: { sessionPrincipal } } }) as unknown as Composed;

test("the session's org role reaches the workspace principal lookup", async () => {
  const seen: unknown[] = [];
  const composed = composedWith((input) => {
    seen.push(input);
    return Promise.resolve(null);
  });
  await buildContext({
    composed,
    session: { orgId: "org_a", orgRole: "org:admin", userId: "user_1" },
  });
  expect(seen).toEqual([
    { orgId: "org_a", orgRole: "org:admin", userId: "user_1" },
  ]);
});

test("a signed-out session looks up no principal", async () => {
  const composed = composedWith(() => {
    throw new Error("not expected");
  });
  const context = await buildContext({ composed, session: { userId: null } });
  expect(context.principal).toBeNull();
});

test("a pending session has a user id but no principal", async () => {
  const composed = composedWith(() => {
    throw new Error("not expected");
  });
  const context = await buildContext({
    composed,
    session: { anyUserId: "user_1", userId: null },
  });
  expect(context.principal).toBeNull();
  expect(context.userId).toBe("user_1");
});

test("without a pending-session user id, the user id is the session's", async () => {
  const composed = composedWith(() => Promise.resolve(null));
  const context = await buildContext({
    composed,
    session: { userId: "user_1" },
  });
  expect(context.userId).toBe("user_1");
});
