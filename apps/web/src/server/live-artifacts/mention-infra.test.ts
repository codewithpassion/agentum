import { expect, test } from "bun:test";
import { createLiveArtifactsWithAsk } from "@repo/services/live-artifacts/factory";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { principals } from "../../../../../packages/services/src/artifacts/test-harness";
import { interactionFixture } from "../../../../../packages/services/src/live-artifacts/interaction-fixture";
import { mentionEmailAdapter } from "./mention-infra";

test("actual EMAIL adapter capture retries a failed transport and deduplicates acknowledged intent", async () => {
  const h = interactionFixture();
  const artifactId = await h.create();
  h.grant(artifactId);
  let time = Date.parse("2026-10-27T00:00:00Z");
  const failures = new Set(["first-attempt"]);
  const captured: EmailMessageBuilder[] = [];
  const send = mentionEmailAdapter(
    {
      send: (mail: EmailMessage | EmailMessageBuilder) => {
        if (failures.delete("first-attempt")) {
          return Promise.reject(new Error("capture transport down"));
        }
        if (!("subject" in mail)) {
          return Promise.reject(new Error("Expected composed mail"));
        }
        captured.push(mail);
        return Promise.resolve({ messageId: "capture-only" });
      },
    },
    "noreply@example.com",
    "https://app.example.com/path"
  );
  const person = {
    email: "new-verified@example.com",
    name: "Ann",
    principal: principals.stranger,
  };
  const service = createLiveArtifactsWithAsk({
    ...h.deps,
    clock: { ...h.deps.clock, now: () => new Date(time) },
    mentions: {
      byEmail: () => Promise.resolve(person),
      recipient: () => Promise.resolve(person),
      send,
    },
  });
  await service.comment(principals.owner, {
    artifactId,
    body: `@[Ann](member:u2) <img src=x onerror=alert(1)> ${"bounded ".repeat(100)}`,
  });
  await service.retryMentions(SYSTEM_PRINCIPAL);
  expect(captured).toHaveLength(0);
  time += 61_000;
  await service.retryMentions(SYSTEM_PRINCIPAL);
  await service.retryMentions(SYSTEM_PRINCIPAL);
  expect(captured).toHaveLength(1);
  expect(captured[0]?.to).toBe("new-verified@example.com");
  expect(captured[0]?.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(captured[0]?.html).not.toContain("<img");
  expect(captured[0]?.text).toContain(
    `https://app.example.com/a/${artifactId}#comment-`
  );
  expect(captured[0]?.text?.length).toBeLessThan(800);
  expect(captured[0]?.headers?.["X-Harbourmaster-Delivery"]).toBeTruthy();
});
