import { expect, test } from "bun:test";
import type { ArtifactCall } from "@repo/protocol/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs, TabsList } from "#/components/ui/tabs";
import { CallsTable, CallsTabTrigger, RecentErrors } from "./calls.tsx";

const call: ArtifactCall = {
  durationMs: 37,
  endpoint: "discord",
  id: "call_1",
  outcome: "error",
  place: "AU",
  statusCode: 502,
  time: "2026-11-05T00:00:00.000Z",
  version: 3,
};

test("calls renders rows with phone card labels and nullable historical metrics", () => {
  const html = renderToStaticMarkup(
    <CallsTable
      calls={[
        call,
        {
          ...call,
          durationMs: null,
          id: "old",
          statusCode: null,
          version: null,
        },
      ]}
    />
  );
  for (const label of [
    "Time",
    "Endpoint",
    "Status",
    "Duration",
    "Place",
    "Version",
  ]) {
    expect(html).toContain(`data-label="${label}"`);
  }
  for (const value of ["discord", "502", "37 ms", "AU"]) {
    expect(html).toContain(value);
  }
});

test("calls renders the specified empty state", () => {
  expect(renderToStaticMarkup(<CallsTable calls={[]} />)).toContain(
    "No calls yet. Requests to this app&#x27;s endpoints show here."
  );
});

test("recent errors show diagnostic fields and dropped count only when present", () => {
  expect(renderToStaticMarkup(<RecentErrors errors={[]} />)).toBe("");
  const html = renderToStaticMarkup(
    <RecentErrors
      errors={[
        {
          dropped: 8,
          entry: "server.ts",
          message: "Failed to connect",
          time: call.time,
          version: 3,
          versionId: "v3",
        },
      ]}
    />
  );
  for (const value of [
    "Recent errors",
    "server.ts",
    "Failed to connect",
    "8 similar errors dropped",
    "Version 3",
  ]) {
    expect(html).toContain(value);
  }
});

test("Endpoints tab only shows for an app manager", () => {
  const render = (kind: "app" | "file", canManage: boolean) =>
    renderToStaticMarkup(
      <Tabs defaultValue="artifact">
        <TabsList>
          <CallsTabTrigger canManage={canManage} kind={kind} />
        </TabsList>
      </Tabs>
    );
  expect(render("app", true)).toContain("Endpoints");
  expect(render("app", false)).not.toContain("Endpoints");
  expect(render("file", true)).not.toContain("Endpoints");
});
