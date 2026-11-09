import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnrollStatus, WAIT_BEFORE_HINT_MS } from "./enroll-status";

test("waiting shows no hint before a minute", () => {
  const html = renderToStaticMarkup(
    <EnrollStatus connectedName={null} elapsedMs={5000} origin="https://x.io" />
  );
  expect(html).toContain("Waiting for the machine");
  expect(html).not.toContain("Check that");
});

test("after a minute it says what to check", () => {
  const html = renderToStaticMarkup(
    <EnrollStatus
      connectedName={null}
      elapsedMs={WAIT_BEFORE_HINT_MS}
      origin="https://x.io"
    />
  );
  expect(html).toContain("Check that");
  expect(html).toContain("https://x.io");
});

test("a connected machine shows its name", () => {
  const html = renderToStaticMarkup(
    <EnrollStatus
      connectedName="Office"
      elapsedMs={1000}
      origin="https://x.io"
    />
  );
  expect(html).toContain("Connected");
  expect(html).toContain("Office");
});
