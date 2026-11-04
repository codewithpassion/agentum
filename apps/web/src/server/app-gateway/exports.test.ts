import { expect, test } from "bun:test";
import { file, Glob } from "bun";
import ts from "typescript";

const EXPORTS_ARGUMENT = /exports$|^exportsOf\(ctx\)$/;
const root = new URL("../../", import.meta.url);

const readOnlyServerCall = (node: ts.CallExpression, source: ts.SourceFile) => {
  if (node.getText(source) !== "compose(env, false)") {
    return false;
  }
  const { parent } = node;
  // These exact callbacks only authorize public artifact/guest reads.
  return (
    (ts.isCallExpression(parent) &&
      parent.getText(source) === "guestEmbeds(env, compose(env, false))" &&
      parent.parent.parent.getText(source) ===
        "guestEmbeds(env, compose(env, false)).authorize(claims)") ||
    (ts.isArrowFunction(parent) &&
      ts.isPropertyAssignment(parent.parent) &&
      parent.parent.getText(source) ===
        "compose: (env) => compose(env, false)" &&
      ts.isObjectLiteralExpression(parent.parent.parent) &&
      ts.isCallExpression(parent.parent.parent.parent) &&
      parent.parent.parent.parent.expression.getText(source) === "guestRoutes")
  );
};

test("every source compose caller that can finish a run passes exports and defer", async () => {
  let checked = 0;
  let readOnly = 0;
  for await (const path of new Glob("**/*.{ts,tsx}").scan(root.pathname)) {
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
      continue;
    }
    const text = await file(new URL(path, root)).text();
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "compose"
      ) {
        if (path === "server.ts" && readOnlyServerCall(node, source)) {
          readOnly += 1;
        } else if (path === "server/secrets-outbound.ts") {
          // SecretsOutbound only fills approved outbound headers and announces
          // secret injection; it cannot complete a run or deliver a reply.
          expect(node.getText(source)).toBe(
            "compose(this.env, import.meta.env.DEV)"
          );
        } else {
          checked += 1;
          const [, , defer] = node.arguments;
          expect(
            defer &&
              (ts.isArrowFunction(defer) ||
                defer.getText(source) === "waitUntil"),
            `${path}: missing defer: ${node.getText(source)}`
          ).toBe(true);
          expect(
            node.arguments[3]?.getText(source),
            `${path}: ${node.getText(source)}`
          ).toMatch(EXPORTS_ARGUMENT);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(checked).toBeGreaterThan(0);
  expect(readOnly).toBe(2);
});

test("AppHost composition receives the Worker's exports", async () => {
  const entry = await file(
    new URL("../app-entrypoints.ts", import.meta.url)
  ).text();
  const wiring = await file(new URL("./wiring.ts", import.meta.url)).text();
  expect(entry).toContain("exports");
  expect(wiring).toContain("compose(env, dev, waitUntil, exports)");
});
