import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EndpointList } from "./endpoint-settings.tsx";

test("endpoint settings show complete addresses and Copy, Disable/Enable and Rotate actions", () => {
  const html = renderToStaticMarkup(<EndpointList busy={false} endpoints={[
    { id: "one", name: "discord", url: "https://agentum.test/hooks/one", disabledAt: null },
    { id: "two", name: "github", url: "https://agentum.test/hooks/two", disabledAt: "now" },
  ]} onCopy={() => undefined} onChange={() => undefined} />);
  expect(html).toContain("https://agentum.test/hooks/one");
  for (const action of ["Copy", "Disable", "Enable", "Rotate"]) expect(html).toContain(`>${action}</button>`);
});
