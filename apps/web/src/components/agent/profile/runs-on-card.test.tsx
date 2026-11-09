import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentProfileView } from "#/integrations/trpc/types";
import { RunsOnCard } from "./runs-on-card.tsx";

const noop = () => undefined;
const header = (
  overrides: Partial<AgentProfileView["header"]>
): AgentProfileView["header"] => ({
  emailLocal: null,
  id: "agent_1",
  machine: null,
  model: "claude",
  name: "Sorter",
  runtime: "cloud",
  slug: "sorter",
  status: "active",
  waitingRun: null,
  ...overrides,
});
const render = (overrides: Partial<AgentProfileView["header"]>) =>
  renderToStaticMarkup(
    <RunsOnCard header={header(overrides)} onAdvanced={noop} />
  );

test("shows only the current runtime as one line with its detail", () => {
  const html = render({ runtime: "cloud" });
  expect(html).toContain("Cloudflare");
  expect(html).toContain("Always on, lowest cost for many small jobs.");
  expect(html).not.toContain("Anthropic cloud");
  expect(html).not.toContain("Our machine");
  expect(html).not.toContain("<li");
});

test("shows the machine and its state for a machine agent", () => {
  const html = render({
    machine: { id: "m1", name: "laptop", status: "online" },
    runtime: "machine",
  });
  expect(html).toContain("Our machine: laptop");
  expect(html).toContain("Online");
});

test("offers no choice-like marker or runtime control", () => {
  const html = render({ runtime: "managed" });
  expect(html).not.toContain("Current");
  expect(html).not.toContain("<select");
  expect(html).not.toContain(`disabled=""`);
});
