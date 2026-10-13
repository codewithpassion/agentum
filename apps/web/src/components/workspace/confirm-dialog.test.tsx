import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResetNotice } from "./agent-session-reset";
import { ConfirmBody } from "./confirm-dialog";

const noop = () => undefined;
const render = (busy: boolean, error: string | null) =>
  renderToStaticMarkup(
    <ConfirmBody
      busy={busy}
      confirmLabel="Confirm"
      error={error}
      message="Sure?"
      onCancel={noop}
      onConfirm={noop}
    />
  );

describe("ConfirmBody", () => {
  test("shows a working label and disables both buttons while busy", () => {
    const html = render(true, null);
    expect(html).toContain("Working");
    expect(html).not.toContain(">Confirm<");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("shows the confirm label when idle", () => {
    const html = render(false, null);
    expect(html).toContain(">Confirm<");
    expect(html).not.toContain("disabled=");
  });

  test("shows the error text as an alert", () => {
    const html = render(false, "Boom happened.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Boom happened.");
  });
});

describe("ResetNotice", () => {
  test("renders the message as a status box", () => {
    const html = renderToStaticMarkup(<ResetNotice message="Session reset." />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Session reset.");
  });
});
