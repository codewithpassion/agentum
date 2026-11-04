import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GrantApprovalView } from "./grant-approval-card.tsx";
import type { PromoteApproval } from "./grant-approval-model.ts";

const noop = () => undefined;

const items = (overrides: Partial<PromoteApproval> = {}): PromoteApproval => ({
  agents: [],
  artifactId: "a1",
  endpoints: [],
  grantIds: ["g1", "g2", "g3", "g4"],
  hosts: ["api.example.com"],
  secrets: ["API_KEY"],
  title: "Tracker",
  tools: ["gmail_send"],
  version: 3,
  versionId: "v3",
  ...overrides,
});

const render = (
  props: { error?: string | null; items?: PromoteApproval } = {}
) =>
  renderToStaticMarkup(
    <GrantApprovalView
      busy={false}
      error={props.error ?? null}
      expiresText="expires in 5 min"
      items={props.items ?? items()}
      onApprove={noop}
      onReject={noop}
    />
  );

test("renders the heading, the three lists, the expiry and both buttons", () => {
  const html = render();
  expect(html).toContain("Tracker v3 asks for access");
  expect(html).toContain("Tools");
  expect(html).toContain("gmail_send");
  expect(html).toContain("Hosts");
  expect(html).toContain("api.example.com");
  expect(html).toContain("Secrets");
  expect(html).toContain("API_KEY");
  expect(html).toContain("expires in 5 min");
  expect(html).toContain(">Approve</button>");
  expect(html).toContain(">Reject</button>");
});

test("omits empty lists", () => {
  const html = render({ items: items({ hosts: [], secrets: [] }) });
  expect(html).toContain("Tools");
  expect(html).not.toContain("Hosts");
  expect(html).not.toContain("Secrets");
});

test("renders an error with role alert and none otherwise", () => {
  expect(render({ error: "Boom" })).toContain('role="alert"');
  expect(render({ error: "Boom" })).toContain("Boom");
  expect(render()).not.toContain('role="alert"');
});

test("disables both buttons while busy", () => {
  const html = renderToStaticMarkup(
    <GrantApprovalView
      busy
      error={null}
      expiresText="x"
      items={items()}
      onApprove={noop}
      onReject={noop}
    />
  );
  expect(html.match(/disabled=""/g)?.length).toBe(2);
});
