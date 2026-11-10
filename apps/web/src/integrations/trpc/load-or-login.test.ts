import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { hasTrpcCode, loadOrLogin } from "./load-or-login.ts";

const trpcError = (code: string) =>
  Object.assign(new TRPCClientError("failed"), { data: { code } });

test("loadOrLogin returns what the loader read", async () => {
  expect(await loadOrLogin(() => Promise.resolve(7))).toBe(7);
});

test("loadOrLogin sends an UNAUTHORIZED error to /login", async () => {
  const caught = await loadOrLogin(() =>
    Promise.reject(trpcError("UNAUTHORIZED"))
  ).catch((error: unknown) => error);
  expect(isRedirect(caught)).toBe(true);
  expect(isRedirect(caught) && caught.options.to).toBe("/login");
});

test("loadOrLogin rethrows every other error", async () => {
  const other = trpcError("INTERNAL_SERVER_ERROR");
  await expect(loadOrLogin(() => Promise.reject(other))).rejects.toBe(other);
  const plain = new Error("boom");
  await expect(loadOrLogin(() => Promise.reject(plain))).rejects.toBe(plain);
});

test("hasTrpcCode matches only a tRPC error with that code", () => {
  expect(hasTrpcCode(trpcError("NOT_FOUND"), "NOT_FOUND")).toBe(true);
  expect(hasTrpcCode(trpcError("NOT_FOUND"), "FORBIDDEN")).toBe(false);
  expect(hasTrpcCode(new Error("x"), "NOT_FOUND")).toBe(false);
});
