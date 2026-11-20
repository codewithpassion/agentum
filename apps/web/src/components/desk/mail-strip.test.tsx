import { expect, test } from "bun:test";
import { renderInRoom } from "#/components/agent/room/test-fixtures.tsx";
import { MailStrip } from "./mail-strip.tsx";

test("a mail row opens the agent room on Keys with the mail list", () => {
  const html = renderInRoom(
    <MailStrip
      agent={undefined}
      rows={[{ address: "a1@agents.test", agentId: "a1", held: 0, in: 2 }]}
    />
  );
  expect(html).toContain('href="/agents/a1?');
  expect(html).toContain("tab=keys");
  expect(html).toContain("mail=1");
  expect(html).not.toContain("%22");
});
