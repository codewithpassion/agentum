import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  connectorCallsOf,
  DEAD_CONNECTOR_URL,
  type ProxyDeps,
  ProxyError,
  parseConnectorUrl,
  runCloudProxy,
} from "./cloud-proxy.ts";

const eventsDb = (): Database => {
  const client = new Database(":memory:");
  client.run(
    "CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT, type TEXT, payload TEXT)"
  );
  return client;
};

describe("connectorCallsOf", () => {
  test("reads the connector.call events of one run and no other", () => {
    const client = eventsDb();
    client.run(
      "INSERT INTO events (id, run_id, type, payload) VALUES ('1', 'run-a', 'connector.call', ?)",
      [JSON.stringify({ connectorId: "c1", outcome: "ok" })]
    );
    client.run(
      "INSERT INTO events (id, run_id, type, payload) VALUES ('2', 'run-a', 'message.assistant', ?)",
      [JSON.stringify({ text: "hi" })]
    );
    client.run(
      "INSERT INTO events (id, run_id, type, payload) VALUES ('3', 'run-b', 'connector.call', ?)",
      [JSON.stringify({ connectorId: "c2", outcome: "ok" })]
    );

    expect(connectorCallsOf(client, "run-a")).toEqual([
      { payload: { connectorId: "c1", outcome: "ok" }, type: "connector.call" },
    ]);
  });
});

describe("parseConnectorUrl", () => {
  test("takes an https URL and rejects a missing, malformed or plain http one", () => {
    expect(parseConnectorUrl("https://abc.trycloudflare.com/mcp")).toBe(
      "https://abc.trycloudflare.com/mcp"
    );
    expect(() => parseConnectorUrl(undefined)).toThrow(
      "--connector-url is required"
    );
    expect(() => parseConnectorUrl("not a url")).toThrow("is not a URL");
    expect(() => parseConnectorUrl("http://localhost:8787/mcp")).toThrow(
      "must be https"
    );
  });
});

const STUB_URL = "https://stub.example.test/mcp";

/**
 * A dev server and a stub in miniature. Each run answers as the faux model would
 * when the proxy and the stub work. `options` breaks one part of that.
 */
const fakeDeps = (
  options: { noProxyEvent?: boolean; noToolOutput?: boolean } = {}
) => {
  const runs = new Map<string, { agentId: string; text: string }>();
  const connectors = new Map<
    string,
    { id: string; name: string; url: string }
  >();
  const assigned = new Map<string, string[]>();
  const statuses = new Map<string, "done">();
  const calls: string[] = [];
  const out: string[] = [];
  let count = 0;

  const resultFor = (text: string): string => {
    if (text.startsWith("call stub_echo ")) {
      const args = JSON.parse(text.slice("call stub_echo ".length)) as {
        text: string;
      };
      return options.noToolOutput ? "" : `echo: ${args.text}`;
    }
    if (text.startsWith("bash ")) {
      return `tool said: ${text.slice("bash ".length)}`;
    }
    return "";
  };

  const deps: ProxyDeps = {
    assign: (agentId, connectorId) => {
      assigned.set(agentId, [...(assigned.get(agentId) ?? []), connectorId]);
      return Promise.resolve();
    },
    connect: (name, url) => {
      const id = `conn-${name}`;
      connectors.set(name, { id, name, url });
      return Promise.resolve(id);
    },
    connectorUrl: STUB_URL,
    createAgent: (name) => {
      count += 1;
      calls.push(`agent ${name}`);
      return Promise.resolve(`agent-${count}`);
    },
    drive: (action, runId) => {
      calls.push(`${action} ${runId}`);
      statuses.set(runId, "done");
      return Promise.resolve();
    },
    eventsOf: (runId) => {
      const run = runs.get(runId);
      if (!run?.text.startsWith("call stub_echo ") || options.noProxyEvent) {
        return [];
      }
      const stub = connectors.get("stub");
      const attached = assigned.get(run.agentId)?.includes(stub?.id ?? "");
      return attached
        ? [
            {
              payload: { connectorId: stub?.id, outcome: "ok" },
              type: "connector.call",
            },
          ]
        : [];
    },
    out: (line) => out.push(line),
    send: (agentId, text) => {
      count += 1;
      const runId = `run-${count}`;
      runs.set(runId, { agentId, text });
      return Promise.resolve(runId);
    },
    wait: (runId) =>
      Promise.resolve({
        error: null,
        resultText: resultFor(runs.get(runId)?.text ?? ""),
        status: statuses.get(runId) ?? "done",
      }),
  };
  return { calls, connectors, deps, out };
};

describe("runCloudProxy", () => {
  test("passes when the proxied call, the run beside a dead connector and the call after it all hold", async () => {
    const { connectors, deps, out } = fakeDeps();
    await runCloudProxy(deps);
    expect(out).toEqual([
      "ok 1: a tool call through the connector proxy reaches the stub",
      "ok 2: an unreachable connector does not fail the run start",
      "ok 3: the proxied tool still answers beside a dead connector",
      "cloud proxy check passed",
    ]);
    expect(connectors.get("stub")?.url).toBe(STUB_URL);
    expect(connectors.get("dead")?.url).toBe(DEAD_CONNECTOR_URL);
  });

  test("fails with a clear error when the proxied call leaves no ok connector.call event", async () => {
    const { deps } = fakeDeps({ noProxyEvent: true });
    const failure = runCloudProxy(deps);
    await expect(failure).rejects.toThrow(ProxyError);
    await expect(failure).rejects.toThrow(
      "proxy run: expected an ok connector.call"
    );
  });

  test("fails when the proxied call's result lacks the echoed text", async () => {
    const { deps } = fakeDeps({ noToolOutput: true });
    await expect(runCloudProxy(deps)).rejects.toThrow(
      'proxy run: expected the result to contain "through-the-proxy"'
    );
  });
});
