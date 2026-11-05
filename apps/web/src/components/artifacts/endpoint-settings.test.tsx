import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EndpointList } from "./endpoint-settings.tsx";

const noop = () => undefined;

test("endpoint settings show complete addresses and Copy, Disable/Enable and Rotate actions", () => {
  const html = renderToStaticMarkup(
    <EndpointList
      busy={false}
      endpoints={[
        {
          disabledAt: null,
          id: "one",
          name: "discord",
          url: "https://agentum.test/hooks/one",
        },
        {
          disabledAt: "now",
          id: "two",
          name: "github",
          url: "https://agentum.test/hooks/two",
        },
      ]}
      onChange={noop}
      onCopy={noop}
    />
  );
  expect(html).toContain("https://agentum.test/hooks/one");
  for (const action of ["Copy", "Disable", "Enable", "Rotate"]) {
    expect(html).toContain(`>${action}</button>`);
  }
});

test("copied address receives visible feedback", () => {
  const html = renderToStaticMarkup(
    <EndpointList
      busy={false}
      copiedUrl="https://agentum.test/hooks/one"
      endpoints={[
        {
          disabledAt: null,
          id: "one",
          name: "discord",
          url: "https://agentum.test/hooks/one",
        },
      ]}
      onChange={noop}
      onCopy={noop}
    />
  );
  expect(html).toContain(">Copied</button>");
});

test("endpoint list explains how endpoints go live when empty", () => {
  const html = renderToStaticMarkup(
    <EndpointList busy={false} endpoints={[]} onChange={noop} onCopy={noop} />
  );
  expect(html).toContain(
    "This app has no approved endpoints yet. An endpoint is declared in the app&#x27;s agentum.json and goes live when its version is approved."
  );
});
