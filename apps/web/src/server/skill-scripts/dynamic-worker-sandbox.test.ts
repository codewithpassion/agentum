import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dynamicWorkerSandbox } from "./dynamic-worker-sandbox.ts";
import { localWorkerLoader } from "./local-worker-loader.ts";
import {
  type SandboxFile,
  type SandboxRunInput,
  TIMEOUT_EXIT_CODE,
} from "./sandbox-port.ts";
import type { BundleModule } from "./script-bundle.ts";
import type {
  HostEntry,
  HostFetchRequest,
  HostFetchResult,
  ScriptHostApi,
} from "./script-host-api.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fileOf = (path: string, text: string): SandboxFile => ({
  bytes: encoder.encode(text),
  path,
});

const runInput = (
  files: SandboxFile[],
  overrides: Partial<SandboxRunInput> = {}
): SandboxRunInput => ({
  args: [],
  entry: "scripts/main.ts",
  files,
  maxOutputBytes: 65_536,
  skill: "demo",
  timeoutMs: 5000,
  ...overrides,
});

const jsOf = (
  config: { modules: Record<string, BundleModule> } | undefined,
  path: string
): string => {
  const module = config?.modules[path];
  if (module === undefined || !("js" in module)) {
    throw new Error(`no js module at ${path}`);
  }
  return module.js;
};

interface HostStub extends ScriptHostApi {
  sent: HostFetchRequest[];
}

/** An in-memory ScriptHostApi. `reply` is what `send` answers. */
const hostStub = (
  options: { entries?: HostEntry[]; reply?: HostFetchResult } = {}
): HostStub => {
  const files = new Map<string, Uint8Array>();
  const sent: HostFetchRequest[] = [];
  return {
    list: async () => options.entries ?? [],
    read: (path) => {
      const bytes = files.get(path);
      return bytes === undefined
        ? Promise.reject(new Error(`missing ${path}`))
        : Promise.resolve(bytes);
    },
    send: (request) => {
      sent.push(request);
      return Promise.resolve(
        options.reply ?? { message: "no reply set", ok: false }
      );
    },
    sent,
    write: (path, bytes) => {
      files.set(path, bytes);
      return Promise.resolve();
    },
  };
};

describe("dynamicWorkerSandbox", () => {
  let helper: ReturnType<typeof localWorkerLoader>;

  beforeEach(() => {
    helper = localWorkerLoader();
  });

  afterEach(() => {
    helper.restore();
  });

  test("runs a TypeScript entry with a relative import", async () => {
    const sandbox = dynamicWorkerSandbox(helper.loader);
    const result = await sandbox.run(
      runInput([
        fileOf(
          "scripts/main.ts",
          [
            'import { greet } from "./lib.ts";',
            'const name: string = "harbour";',
            "function main() {",
            "  console.log(greet(name));",
            "}",
            "main();",
            "",
          ].join("\n")
        ),
        fileOf(
          "scripts/lib.ts",
          'export const greet = (who: string): string => "hello " + who;\n'
        ),
      ])
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "hello harbour\n",
    });
    const lib = jsOf(helper.configs[0], "scripts/lib.ts");
    expect(lib).toContain("greet");
    expect(lib).not.toContain(": string");
  });

  test("reports a thrown error as exit code 1 with its message on stderr", async () => {
    const sandbox = dynamicWorkerSandbox(helper.loader);
    const result = await sandbox.run(
      runInput([fileOf("scripts/main.ts", 'throw new Error("boom");\n')])
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  test("process.exit sets the exit code, and argv carries the args", async () => {
    const sandbox = dynamicWorkerSandbox(helper.loader);
    const result = await sandbox.run(
      runInput(
        [
          fileOf(
            "scripts/main.ts",
            'console.log(process.argv.slice(2).join(","));\nprocess.exit(3);\n'
          ),
        ],
        { args: ["one", "two"] }
      )
    );

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("one,two\n");
  });

  test("a script that never settles is stopped at the time limit", async () => {
    const sandbox = dynamicWorkerSandbox(helper.loader);
    const result = await sandbox.run(
      runInput([fileOf("scripts/main.ts", "await new Promise(() => {});\n")], {
        timeoutMs: 100,
      })
    );

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.stderr).toContain("timed out");
  });

  test("a hosted run reads and writes the library and gets stdin and args", async () => {
    const host = hostStub({
      entries: [{ kind: "file", name: "a.txt" }],
    });
    const sandbox = dynamicWorkerSandbox(helper.loader, undefined, () => host);
    const result = await sandbox.run(
      runInput(
        [
          fileOf(
            "scripts/main.ts",
            [
              'await library.write("a.txt", "hi");',
              'console.log(await library.read("a.txt"));',
              'console.log(JSON.stringify(await library.list("")));',
              "console.log(stdin);",
              'console.log(process.argv.slice(2).join(","));',
              "",
            ].join("\n")
          ),
        ],
        { args: ["x", "y"], hosted: true, stdin: "typed input" }
      )
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: 'hi\n[{"kind":"file","name":"a.txt"}]\ntyped input\nx,y\n',
    });
  });

  test("a hosted fetch goes through the host's send", async () => {
    const host = hostStub({
      reply: {
        body: encoder.encode("pong"),
        headers: [["x-a", "1"]],
        ok: true,
        status: 200,
        statusText: "OK",
      },
    });
    const sandbox = dynamicWorkerSandbox(helper.loader, undefined, () => host);
    const result = await sandbox.run(
      runInput(
        [
          fileOf(
            "scripts/main.ts",
            [
              'const res = await fetch("https://example.com/x", { method: "POST", body: "ping" });',
              "console.log(res.status);",
              "console.log(await res.text());",
              'console.log(res.headers.get("x-a"));',
              "",
            ].join("\n")
          ),
        ],
        { hosted: true }
      )
    );

    expect(result.stdout).toBe("200\npong\n1\n");
    expect(host.sent).toHaveLength(1);
    const [request] = host.sent;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://example.com/x");
    expect(request?.body).toBeDefined();
    expect(decoder.decode(request?.body)).toBe("ping");
  });

  test("a refused hosted fetch throws the host's message", async () => {
    const host = hostStub({
      reply: { message: "Network access is off for this agent.", ok: false },
    });
    const sandbox = dynamicWorkerSandbox(helper.loader, undefined, () => host);
    const result = await sandbox.run(
      runInput(
        [
          fileOf(
            "scripts/main.ts",
            [
              "try {",
              '  await fetch("https://example.com/x");',
              "} catch (error) {",
              "  console.log(error.message);",
              "}",
              "",
            ].join("\n")
          ),
        ],
        { hosted: true }
      )
    );

    expect(result.stdout).toBe("Network access is off for this agent.\n");
  });

  test("a hosted run has no globalOutbound and gets the host as HOST", async () => {
    const host = hostStub();
    const fetcher = {} as Fetcher;
    const sandbox = dynamicWorkerSandbox(
      helper.loader,
      () => fetcher,
      () => host
    );
    await sandbox.run(
      runInput([fileOf("scripts/main.ts", 'console.log("ok");\n')], {
        hosted: true,
        proxy: true,
      })
    );

    const [config] = helper.configs;
    expect(config?.globalOutbound).toBeNull();
    expect(config?.env?.HOST).toBe(host);
  });

  test("a run that is not hosted keeps the outbound proxy and has no HOST", async () => {
    const fetcher = {} as Fetcher;
    const sandbox = dynamicWorkerSandbox(helper.loader, () => fetcher);
    await sandbox.run(
      runInput([fileOf("scripts/main.ts", 'console.log("ok");\n')], {
        proxy: true,
      })
    );

    const [config] = helper.configs;
    expect(config?.globalOutbound).toBe(fetcher);
    expect(config?.env).toEqual({});
  });

  test("a run that is not hosted and not proxied has no globalOutbound key", async () => {
    const sandbox = dynamicWorkerSandbox(helper.loader, () => ({}) as Fetcher);
    await sandbox.run(
      runInput([fileOf("scripts/main.ts", 'console.log("ok");\n')])
    );

    expect("globalOutbound" in (helper.configs[0] ?? {})).toBe(false);
  });

  test("a hosted run without a host fails with a message", async () => {
    const sandbox = dynamicWorkerSandbox(helper.loader);
    const result = await sandbox.run(
      runInput([fileOf("scripts/main.ts", 'console.log("ok");\n')], {
        hosted: true,
      })
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no platform host");
    expect(helper.configs).toHaveLength(0);
  });
});
