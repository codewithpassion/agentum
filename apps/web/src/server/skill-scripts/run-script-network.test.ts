import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { NetworkRequestEntry } from "@repo/services/network";
import type { EnvGrant } from "@repo/services/secrets/placeholders";
import type { Services } from "../compose.ts";
import type { LibraryOps } from "../library-bash/library-fs.ts";
import { runWebFetcher } from "../web-fetch/run-fetcher.ts";
import { dynamicWorkerSandbox } from "./dynamic-worker-sandbox.ts";
import { localWorkerLoader } from "./local-worker-loader.ts";
import { runScriptExtension } from "./run-script.ts";
import { createScriptHost } from "./script-host-core.ts";

// The script tool never reads the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};

const TOOL = "run_script";
const HOME = "agents/robo";
const RUN = { agentId: "agent-1", runId: "run-1", workspaceId: "ws-1" };
const SECRET_NAME = "TOKEN";
const SECRET_VALUE = "s3cret-value-xyz";
const GRANT: EnvGrant = {
  hosts: ["api.example.com"],
  name: SECRET_NAME,
  value: SECRET_VALUE,
};
const PLACEHOLDER = `hm-secret:${SECRET_NAME}`;

const textOf = (result: ToolExecutionResult): string => {
  const content = result.output;
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => ("text" in part ? part.text : "")).join("");
};

const toolNamed = (extension: Extension, name: string): ToolRegistration => {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return tool;
};

const execute = (
  extension: Extension,
  args: unknown
): Promise<ToolExecutionResult> =>
  toolNamed(extension, TOOL).execute(
    args,
    NO_API,
    CONTEXT
  ) as Promise<ToolExecutionResult>;

const answerPong = (): Promise<Response> =>
  Promise.resolve(new Response("pong", { status: 200 }));

/** A library with no files: the network cases never read it. */
const emptyLibrary: Pick<LibraryOps, "list" | "read" | "write"> = {
  list: () => Promise.resolve([]),
  read: () => Promise.reject(new Error("no such file")),
  write: () => Promise.reject(new Error("the library is read only here")),
};

describe("run_script with the network", () => {
  let helper: ReturnType<typeof localWorkerLoader>;

  beforeEach(() => {
    helper = localWorkerLoader();
  });

  afterEach(() => {
    helper.restore();
  });

  /**
   * The extension with the platform fetcher, or with network off. `sent` holds
   * each request the fake `fetch` saw, and `recorded` each network entry.
   */
  const setup = ({
    grants = [],
    network,
    answer = answerPong,
  }: {
    answer?: (request: Request) => Promise<Response>;
    grants?: readonly EnvGrant[];
    network: boolean;
  }) => {
    const sent: Request[] = [];
    const recorded: NetworkRequestEntry[] = [];
    const services = {
      network: {
        recordRequest: (_run: unknown, entry: NetworkRequestEntry) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      },
      secrets: {
        announceInjection: () => Promise.resolve(),
        envGrantsFor: () => Promise.resolve(grants),
        proxyFor: () => Promise.resolve([]),
      },
    } as unknown as Pick<Services, "network" | "secrets">;
    const fetcher = network
      ? runWebFetcher({
          fetch: (request) => {
            sent.push(request);
            return answer(request);
          },
          ownHosts: [],
          run: RUN,
          services,
          via: "run_script",
        })
      : undefined;
    const extension = runScriptExtension({
      homeOf: () => Promise.resolve(HOME),
      read: () => Promise.resolve(null),
      record: () => Promise.resolve(),
      sandboxOf: () =>
        Promise.resolve(
          dynamicWorkerSandbox(helper.loader, undefined, () =>
            createScriptHost({ fetcher, home: HOME, ops: emptyLibrary })
          )
        ),
    });
    return { extension, recorded, sent };
  };

  test("with network off, fetch fails with the network-off message", async () => {
    const { extension, sent } = setup({ network: false });
    const result = await execute(extension, {
      code: `try { await fetch("https://example.com/") } catch (e) { console.log("failed:", e.message) }`,
      language: "js",
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("exit code: 0");
    expect(textOf(result)).toContain(
      "stdout:\nfailed: Network access is off for this agent.\n"
    );
    expect(sent).toEqual([]);
  });

  test("with network on, a GET returns the answer and records one run_script entry", async () => {
    const { extension, recorded, sent } = setup({ network: true });
    const result = await execute(extension, {
      code: [
        'const res = await fetch("https://example.com/ping");',
        "console.log(res.status, await res.text());",
        "",
      ].join("\n"),
      language: "js",
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("stdout:\n200 pong\n");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://example.com/ping");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      host: "example.com",
      method: "GET",
      status: 200,
      via: "run_script",
    });
    expect(JSON.stringify(recorded)).not.toContain("/ping");
  });

  test("a loopback or metadata address is refused, and the script sees the refusal", async () => {
    const { extension, recorded, sent } = setup({ network: true });
    const result = await execute(extension, {
      code: [
        'for (const url of ["http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/"]) {',
        "  try { await fetch(url) } catch (e) { console.log('failed:', e.message) }",
        "}",
        "",
      ].join("\n"),
      language: "js",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("exit code: 0");
    const failures = text
      .split("\n")
      .filter((line) => line.startsWith("failed: "));
    expect(failures).toHaveLength(2);
    for (const line of failures) {
      expect(line).toContain("The request was refused:");
    }
    expect(sent).toEqual([]);
    expect(recorded.map((entry) => entry.host)).toEqual([
      "127.0.0.1",
      "169.254.169.254",
    ]);
    for (const entry of recorded) {
      expect(entry.blocked).toEqual(expect.any(String));
      expect(entry.via).toBe("run_script");
    }
  });

  // Like web_fetch, the fetcher scrubs response headers and the status text but not the body.
  test("a placeholder goes out as the real value to its host, and an echoing header shows the placeholder", async () => {
    const { extension, sent } = setup({
      answer: (request) =>
        Promise.resolve(
          new Response("ok", {
            headers: { "x-echo": request.headers.get("authorization") ?? "" },
            status: 200,
          })
        ),
      grants: [GRANT],
      network: true,
    });
    const result = await execute(extension, {
      code: [
        `const res = await fetch("https://api.example.com/me", { headers: { authorization: "Bearer ${PLACEHOLDER}" } });`,
        'console.log(res.headers.get("x-echo"));',
        "",
      ].join("\n"),
      language: "js",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("authorization")).toBe(
      `Bearer ${SECRET_VALUE}`
    );
    expect(textOf(result)).toContain("exit code: 0");
    expect(textOf(result)).not.toContain(SECRET_VALUE);
    expect(textOf(result)).toContain(PLACEHOLDER);
  });

  test("a placeholder aimed at a host the secret does not allow is refused before fetch", async () => {
    const { extension, recorded, sent } = setup({
      grants: [GRANT],
      network: true,
    });
    const result = await execute(extension, {
      code: [
        "try {",
        `  await fetch("https://example.com/", { headers: { authorization: "Bearer ${PLACEHOLDER}" } });`,
        '} catch (e) { console.log("failed:", e.message) }',
        "",
      ].join("\n"),
      language: "js",
    });

    const text = textOf(result);
    expect(text).toContain("failed: The request was refused:");
    expect(text).toContain(SECRET_NAME);
    expect(text).not.toContain(SECRET_VALUE);
    expect(sent).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ host: "example.com" });
    expect(recorded[0]?.blocked).toEqual(expect.any(String));
  });

  test("a POST body reaches the fetch as a POST with the same text", async () => {
    const { extension, sent } = setup({ network: true });
    const result = await execute(extension, {
      code: [
        'const res = await fetch("https://example.com/submit", { method: "POST", body: "ping" });',
        "console.log(res.status);",
        "",
      ].join("\n"),
      language: "js",
    });

    expect(textOf(result)).toContain("stdout:\n200\n");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(await sent[0]?.text()).toBe("ping");
  });
});
