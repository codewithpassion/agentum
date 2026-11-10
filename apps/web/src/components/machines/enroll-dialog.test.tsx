import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computerRoleEnrollment,
  DEFAULT_ENROLL_ROLE,
  EnrollRoleChoices,
  RUST_ADD_ROLE_NOTE,
} from "./enroll-dialog";
import { ENROLL_BUTTON_LABEL } from "./machine-logic";

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

test("adding a role to Rust creates an unbound both-roles code and explains replacement", () => {
  expect(
    computerRoleEnrollment({ id: "m", name: "Office", rust: true })
  ).toEqual({ machineName: "Office", role: "both" });
  expect(computerRoleEnrollment({ id: "m", name: "Office" })).toEqual({
    machineId: "m",
    role: "computer",
  });
  expect(RUST_ADD_ROLE_NOTE).toContain("both-roles code");
  expect(RUST_ADD_ROLE_NOTE).toContain("--replace");
});

test("the enrol dialog defaults to both roles and one name", () => {
  expect(DEFAULT_ENROLL_ROLE).toBe("both");
  expect(ENROLL_BUTTON_LABEL).toBe("Enrol a machine");
});
