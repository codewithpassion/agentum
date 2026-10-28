import { expect, test } from "bun:test";
import { clerkRequest } from "./auth";

test("the Clerk request carries no body, so the original stays readable", async () => {
  const post = new Request("https://hm.test/export", {
    body: JSON.stringify({ a: 1 }),
    headers: { "Content-Type": "application/json", Cookie: "a=b; c=d" },
    method: "POST",
  });
  const first = clerkRequest(post, "a=b");
  const second = clerkRequest(post, "a=b");
  for (const request of [first, second]) {
    expect(request.body).toBeNull();
    expect(request.headers.get("Cookie")).toBe("a=b");
  }
  expect(post.bodyUsed).toBe(false);
  expect(await post.json()).toEqual({ a: 1 });
});
