import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "#/components/ui/tooltip";
import { AgentForm, type AgentFormValues } from "./agent-form.tsx";

const noop = () => Promise.resolve();
// The machine runtime links to the machines page when no machine exists.
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});
const initial = (runtime: AgentFormValues["runtime"]): AgentFormValues => ({
  environment: "isolate",
  instructions: "",
  machineId: "",
  maxTurns: "",
  model: "sonnet",
  name: "Agent",
  networkAccess: true,
  runtime,
});
const render = (runtime: AgentFormValues["runtime"]) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TooltipProvider>
        <AgentForm
          initial={initial(runtime)}
          machines={[]}
          onSubmit={noop}
          providerKeys={{ openrouter: true }}
          submitLabel="Save"
        />
      </TooltipProvider>
    </RouterContextProvider>
  );

test("shows the runtime as a read-only line, with no runtime select", () => {
  const html = render("managed");
  expect(html).not.toContain('id="agent-runtime"');
  expect(html).not.toContain('<option value="cloud">');
  expect(html).toContain("Runs on Anthropic cloud");
});

test("names the cloud runtime in the read-only line", () => {
  expect(render("cloud")).toContain("Runs on Cloud");
});

test("names each runtime in the read-only line, without the old names", () => {
  const lines = {
    cloud: "Runs on Cloud",
    machine: "Runs on My computer",
    managed: "Runs on Anthropic cloud",
  } as const;
  for (const [runtime, line] of Object.entries(lines)) {
    const html = render(runtime as AgentFormValues["runtime"]);
    expect(html).toContain(line);
    expect(html).not.toContain("Cloudflare");
    expect(html).not.toContain("Our machine");
  }
});

test("closes the Advanced section, leaving its fields out of the markup", () => {
  expect(render("cloud")).toContain("Advanced");
  expect(render("cloud")).not.toContain('id="agent-environment"');
  expect(render("cloud")).not.toContain('id="agent-network"');
  expect(render("cloud")).not.toContain('id="agent-max-turns"');
  expect(render("managed")).toContain("Advanced");
  expect(render("managed")).not.toContain('id="agent-model"');
  expect(render("machine")).toContain("Advanced");
  expect(render("machine")).not.toContain('id="agent-max-turns"');
  expect(render("machine")).not.toContain('id="agent-model"');
});

test("keeps the labelled model select visible for the cloud runtime", () => {
  const html = render("cloud");
  expect(html).toContain('id="agent-model"');
  expect(html).toContain("Name");
});
