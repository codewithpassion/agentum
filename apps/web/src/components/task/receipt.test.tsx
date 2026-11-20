import { expect, test } from "bun:test";
import type { ReceiptStep } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { Receipt } from "./receipt.tsx";

const resultStep: ReceiptStep = {
  countToNext: null,
  detail: "",
  eventIds: [],
  in: [],
  index: 1,
  kind: "result",
  out: [],
  state: "done",
  title: "Sorted the mail",
};

const AGENT_TILE_PATTERN =
  /<span[^>]*bg-emerald-600[^>]*data-testid="agent-tile">L<\/span>/;
const AGENT_TILE_MARK = /data-testid="agent-tile"/g;
const noAnswer = (): Promise<void> => Promise.resolve();

const renderReceipt = (steps: ReceiptStep[]) =>
  renderToStaticMarkup(
    <Receipt
      avatar={{ color: "green", glyph: "L" }}
      events={[]}
      nowMs={null}
      onAnswer={noAnswer}
      requests={new Map()}
      steps={steps}
    />
  );

test("an agent step draws the agent's stored glyph and colour", () => {
  const html = renderReceipt([resultStep]);
  expect(html).toMatch(AGENT_TILE_PATTERN);
  expect(html.match(AGENT_TILE_MARK)).toHaveLength(1);
});

test("a trigger step keeps its arrow tile and draws no agent tile", () => {
  const html = renderReceipt([{ ...resultStep, kind: "trigger" }]);
  expect(html).toContain("→");
  expect(html).not.toContain('data-testid="agent-tile"');
});
