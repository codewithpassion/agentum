import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnrollRoleChoices } from "./enroll-dialog";

const noop = () => undefined;

test("the enrol dialog offers each role and both together", () => {
  const html = renderToStaticMarkup(
    <EnrollRoleChoices onChoose={noop} selectedRole="both" />
  );
  expect(html).toContain("Runs the agent");
  expect(html).toContain("Computer");
  expect(html).toContain("Both roles");
  expect(html).toContain('aria-pressed="true"');
});
