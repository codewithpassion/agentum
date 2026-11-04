import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TriggerRecord } from "#/integrations/trpc/types";
import { TriggerTable } from "./trigger-table.tsx";

const noop = () => undefined;
const trigger: TriggerRecord = {
  agentId: "a1",
  agentName: "Helper",
  approvedAt: "2026-11-04T00:00:00Z",
  createdAt: "2026-11-04T00:00:00Z",
  disabledAt: null,
  id: "t1",
  kind: "app",
  lastFiredAt: null,
  name: "Discord bot",
  proposedByAgentId: null,
  proposedByRunId: null,
  revokedAt: null,
  tokenPrefix: "",
};

const render = (row: TriggerRecord) =>
  renderToStaticMarkup(
    <TriggerTable
      onApprove={noop}
      onReject={noop}
      onRevoke={noop}
      onToggle={noop}
      showAgent
      triggers={[row]}
    />
  );

test("app triggers show their kind and no token, with pause and revoke controls", () => {
  const html = render(trigger);
  expect(html).toContain("Discord bot");
  expect(html).toContain("App");
  expect(html).toContain("No token");
  expect(html).toContain("active");
  expect(html).toContain(">Pause</button>");
  expect(html).toContain(">Revoke</button>");
  expect(html).not.toContain("awaiting approval");
  expect(html).not.toContain(">Approve</button>");
  expect(html).not.toContain("…");
  expect(render({ ...trigger, disabledAt: "paused" })).toContain(
    ">Resume</button>"
  );
});
