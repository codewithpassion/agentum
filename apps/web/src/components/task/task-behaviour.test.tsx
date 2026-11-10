import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BottomBar } from "../thread/bottom-bar.tsx";
import {
  OutsideInput,
  RunFailure,
  ToolGroup,
} from "../thread/thread-cards.tsx";
import {
  bottomState,
  computerWidth,
  inputSourceKind,
  outsideLabel,
  requestIsVisible,
} from "./task-behaviour.ts";

const noop = () => undefined;

test("bottom bar chooses exactly one state, including a newer working run", () => {
  const base = {
    control: false,
    origin: "ui",
    pending: null,
    working: false,
  } as const;
  expect(bottomState(base)).toBe("composer");
  expect(bottomState({ ...base, working: true })).toBe("working");
  expect(bottomState({ ...base, pending: "question", working: true })).toBe(
    "waiting"
  );
  expect(bottomState({ ...base, control: true, pending: "takeover" })).toBe(
    "control"
  );
  expect(bottomState({ ...base, origin: "trigger" })).toBe("routing");
  expect(bottomState({ ...base, origin: "mail" })).toBe("routing");
  expect(bottomState({ ...base, origin: "mcp", subThread: true })).toBe(
    "composer"
  );
});

test("bar states have their own action, phone Stop, and no disabled composer", () => {
  const render = (
    state: "working" | "waiting" | "control" | "routing",
    requestVisible = false,
    typing = false
  ) =>
    renderToStaticMarkup(
      <BottomBar
        atBottom={false}
        canStop={true}
        onLatest={noop}
        onReview={noop}
        onStop={noop}
        origin="trigger"
        pending="question"
        requestVisible={requestVisible}
        routingHref="/triggers"
        runNumber={3}
        state={state}
        stopping={false}
        typing={typing}
      />
    );
  expect(render("working")).toContain("Run 3 is working");
  expect(render("working")).toContain("Jump to latest");
  expect(render("working")).toContain("Stop");
  expect(render("waiting")).toContain("Go to the request");
  expect(render("waiting", true)).not.toContain("Go to the request");
  expect(render("waiting", false, true)).toBe("");
  expect(render("control")).toContain("You have control");
  expect(render("routing")).toContain("Open the trigger");
  for (const state of ["working", "waiting", "control", "routing"] as const) {
    expect(render(state)).not.toContain("textarea");
  }
});

test("outside input has a neutral source card; members retain their message styling", () => {
  expect(outsideLabel("person", "Dom")).toBe(null);
  for (const [kind, label] of [
    ["mail", "Mail from jane@example.com"],
    ["trigger", "Trigger: EP staging bot"],
    ["slack", "Slack"],
    ["peer", "Outside agent"],
  ]) {
    const names: Record<string, string> = {
      mail: "jane@example.com",
      trigger: "EP staging bot",
    };
    const source = outsideLabel(kind ?? "", names[kind ?? ""] ?? "");
    expect(source).toBe(label ?? "");
    const html = renderToStaticMarkup(
      <OutsideInput label={source ?? ""}>Outside text</OutsideInput>
    );
    expect(html).toContain("bg-card");
    expect(html).not.toContain("bg-primary");
  }
});

test("failed runs preserve the raw error and only link named model providers", () => {
  const raw = "No model providers configured.\nProvider key missing.";
  const html = renderToStaticMarkup(<RunFailure error={raw} />);
  expect(html).toContain(raw);
  expect(html).toContain("Run failed");
  expect(html).toContain("/settings/model-providers");
  expect(html).not.toContain("Retry");
  expect(
    renderToStaticMarkup(<RunFailure error="Socket closed" />)
  ).not.toContain("href=");
});

test("tool group counts even one call and opens only while running", () => {
  const running = renderToStaticMarkup(
    <ToolGroup names={["read_file", "read_file"]} running={true}>
      Calls
    </ToolGroup>
  );
  expect(running).toContain("2 tool calls");
  expect(running).toContain('data-state="open"');
  const done = renderToStaticMarkup(
    <ToolGroup names={["read_file"]} running={false}>
      Call
    </ToolGroup>
  );
  expect(done).toContain("1 tool call");
  expect(done).toContain('data-state="closed"');
});

test("Computer dock reserves 560px for the conversation and uses a phone tab", () => {
  expect(computerWidth(960)).toBe(400);
  expect(computerWidth(1120)).toBe(560);
  expect(computerWidth(920)).toBe(360);
  expect(computerWidth(800)).toBe(null);
  expect(computerWidth(390)).toBe(null);
});

test("request jump appears only when more than half the card is outside the viewport", () => {
  expect(requestIsVisible(100, 300, 0, 600)).toBe(true);
  expect(requestIsVisible(-100, 300, 0, 600)).toBe(true);
  expect(requestIsVisible(-400, 300, 0, 600)).toBe(false);
});

test("mail and Slack keep outside-input styling even for a resolved member actor", () => {
  expect(inputSourceKind("user", "slack")).toBe("slack");
  expect(inputSourceKind("guest", "mail")).toBe("mail");
  expect(inputSourceKind("user", "person")).toBe("user");
  expect(outsideLabel("trigger", "Trigger: EP bot")).toBe("Trigger: EP bot");
  expect(outsideLabel("mail", "Mail from jane@example.com")).toBe(
    "Mail from jane@example.com"
  );
});
