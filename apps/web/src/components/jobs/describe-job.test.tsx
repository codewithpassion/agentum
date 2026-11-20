import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DescribeJob, type DescribeJobProps } from "./describe-job.tsx";

const AGENTS = [
  { id: "agent_1", name: "Sorter" },
  { id: "agent_2", name: "Writer" },
];

const DISABLED_DRAFT_BUTTON =
  /<button[^>]*disabled=""[^>]*>Draft job<\/button>/;
const DISABLED_DRAFTING_BUTTON =
  /<button[^>]*disabled=""[^>]*>Drafting\.\.\.<\/button>/;

const noop = (): void => undefined;

const render = (overrides: Partial<DescribeJobProps> = {}): string =>
  renderToStaticMarkup(
    <DescribeJob
      agentId="agent_1"
      agents={AGENTS}
      busy={false}
      error={null}
      onSubmit={noop}
      {...overrides}
    />
  );

test("renders the label and the placeholder", () => {
  const html = render();

  expect(html).toContain("Describe a new job");
  expect(html).toContain(
    'placeholder="Every Friday, summarise support tickets for me."'
  );
});

test("with a fixed agent there is no agent select", () => {
  const html = render({ agentId: "agent_1" });

  expect(html).not.toContain("Choose an agent");
  expect(html).not.toContain('id="describe-job-agent"');
});

test("without a fixed agent the select lists every agent", () => {
  const html = render({ agentId: undefined });

  expect(html).toContain("Choose an agent");
  expect(html).toContain(">Sorter</option>");
  expect(html).toContain(">Writer</option>");
});

test("the draft button is disabled on first render with empty text", () => {
  expect(render()).toMatch(DISABLED_DRAFT_BUTTON);
});

test("while busy the button reads Drafting... and is disabled", () => {
  const html = render({ busy: true });

  expect(html).toMatch(DISABLED_DRAFTING_BUTTON);
  expect(html).toContain('readOnly=""');
});

test("an error renders as an alert", () => {
  const html = render({ error: "Could not draft the job" });

  expect(html).toContain('role="alert"');
  expect(html).toContain("Could not draft the job");
});
