import { expect, test } from "bun:test";
import { file } from "bun";
import ts from "typescript";

for (const path of [
  "../../server.ts",
  "../pi-run.ts",
  "../managed-poller.ts",
  "../linux-vm/vm-session.ts",
  "../guest-run.ts",
  "../script-host.ts",
  "../relay.ts",
  "../trpc/context.ts",
  "../live-artifacts/production-room.ts",
  "../live-artifacts/maintenance.ts",
  "../live-artifacts/guest-routes.ts",
  "../live-artifacts/routes.ts",
  "../live-artifacts/fixtures/guest.ts",
  "../live-artifacts/fixtures/guest-execution.ts",
  "../live-artifacts/fixtures/production.ts",
]) {
  test(`${path}: every run-finishing composition passes exports`, async () => {
    const text = await file(new URL(path, import.meta.url)).text();
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true
    );
    let checked = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "compose"
      ) {
        // The two early server compositions only authorize room/embed reads.
        const readOnly =
          path === "../../server.ts" &&
          node.arguments[1]?.getText(source) === "false";
        if (!readOnly) {
          checked += 1;
          expect(node.arguments[3]?.getText(source)).toBeDefined();
          expect(node.arguments[3]?.getText(source).endsWith("exports")).toBe(
            true
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(checked).toBeGreaterThan(0);
  });
}

test("AppHost composition receives the Worker's exports", async () => {
  const entry = await file(
    new URL("../app-entrypoints.ts", import.meta.url)
  ).text();
  const wiring = await file(new URL("./wiring.ts", import.meta.url)).text();
  expect(entry).toContain("exports");
  expect(wiring).toContain("compose(env, dev, undefined, exports)");
});
