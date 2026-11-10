import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HANDS_TO_COPY } from "./profile-logic.ts";
import { WorksWith } from "./works-with.tsx";

test("Works with holds Hands to, Subagents and Peers, each with copy", () => {
  const html = renderToStaticMarkup(
    <WorksWith
      handsTo={<span>hands-slot</span>}
      peers={<span>peers-slot</span>}
      subagents={<span>subagents-slot</span>}
    />
  );
  expect(html).toContain("Works with");
  for (const title of ["Hands to", "Subagents", "Peers"]) {
    expect(html).toContain(`>${title}</h3>`);
  }
  for (const slot of ["hands-slot", "subagents-slot", "peers-slot"]) {
    expect(html).toContain(slot);
  }
  expect(html.indexOf("Hands to")).toBeLessThan(html.indexOf("Subagents"));
  expect(html.indexOf("Subagents")).toBeLessThan(html.indexOf("Peers"));
});

test("says plainly that Hands to is a suggestion to the agent", () => {
  expect(HANDS_TO_COPY).toContain("suggestion to the agent");
  expect(
    renderToStaticMarkup(<WorksWith handsTo="x" subagents="y" />)
  ).toContain("suggestion to the agent");
});

test("leaves out Peers when none are passed", () => {
  const html = renderToStaticMarkup(<WorksWith handsTo="x" subagents="y" />);
  expect(html).not.toContain("Peers");
});
