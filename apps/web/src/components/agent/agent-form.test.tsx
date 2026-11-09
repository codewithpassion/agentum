import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "#/components/ui/tooltip";
import { AgentForm, type AgentFormValues } from "./agent-form.tsx";

const noop = () => Promise.resolve();
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
    <TooltipProvider>
      <AgentForm
        initial={initial(runtime)}
        machines={[]}
        onSubmit={noop}
        providerKeys={{ openrouter: true }}
        submitLabel="Save"
      />
    </TooltipProvider>
  );

test("shows the runtime as a read-only line, with no runtime select", () => {
  const html = render("managed");
  expect(html).not.toContain('id="agent-runtime"');
  expect(html).not.toContain('<option value="cloud">');
  expect(html).toContain("Runs on Anthropic cloud");
});

test("names the cloud runtime in the read-only line", () => {
  expect(render("cloud")).toContain("Runs on Cloudflare");
});
