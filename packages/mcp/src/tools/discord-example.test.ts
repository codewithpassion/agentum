import { expect, test } from "bun:test";
import { discordBotFiles } from "./discord-example.ts";

test("Discord's example answers before the agent hand-off completes", async () => {
  const source =
    discordBotFiles().find((file) => file.path === "server/index.js")?.text ??
    "";
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("publicKey" in key)) {
    throw new Error("Expected a signing key pair");
  }
  const publicKey = Array.from(
    new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
  const js = source.replace("DISCORD_PUBLIC_KEY_HEX", publicKey);
  const app = (
    await import(
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
    )
  ).default;
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  const work: Promise<unknown>[] = [];
  const body = JSON.stringify({
    channel_id: "channel",
    data: { name: "ask", options: [{ name: "question", value: "hello" }] },
    token: "opaque",
    type: 2,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key.privateKey,
        new TextEncoder().encode(timestamp + body)
      )
    ),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
  const result = await Promise.race([
    app.fetch(
      new Request("https://test/", {
        body,
        headers: {
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        },
        method: "POST",
      }),
      { AGENTUM: { startRun: () => pending } },
      { waitUntil: (promise: Promise<unknown>) => work.push(promise) }
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  release();
  await Promise.all(work);
  expect(result).not.toBeNull();
  expect(await result?.json()).toEqual({ type: 5 });
  expect(work).toHaveLength(1);
});
