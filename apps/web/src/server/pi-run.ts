import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  type Cursor,
  createRegistry,
  type EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import type { CloudStart } from "@repo/services/cloud/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { compose } from "./compose.ts";
import { createRunCore, type PiPort, SERVERS_KEY } from "./pi-run-core.ts";
import {
  listMcpTools,
  type McpTool,
  mcpToolRegistrations,
} from "./pi-run-mcp.ts";

const TOOLS_KEY = "mcp-tools";
const ENTRY_PAGE = 500;
const ANTHROPIC = "anthropic";
const RETRY = { baseDelayMs: 1000, enabled: true, maxRetries: 3 };
const COMMIT_EVENTS = new Set([
  "entry_appended",
  "message_end",
  "tool_execution_end",
]);

type ServerTools = Record<string, McpTool[]>;
type Servers = CloudStart["mcpServers"];
type Faux = ReturnType<typeof import("./pi-run-faux.ts")["createFaux"]>;

/**
 * One session's cloud runs on Pi Durable (`docs/reviews/spike-pi-durable.md`).
 * The object is named by the Harbourmaster session id. Each run is one Pi
 * submission whose operation id is the run id, so the session keeps one
 * conversation across its runs. The object reports into the run lifecycle in
 * process, as the system principal, the way the fake runtime does.
 *
 * The logic is in `pi-run-core.ts`. This class is the part only a real Worker
 * can run: the storage, the Pi harness and the calls the runtime makes.
 */
export class PiRun extends DurableObject<Env> {
  readonly registry = createRegistry();
  #core: ReturnType<typeof createRunCore> | undefined;
  readonly #installed = new Set<string>();
  #faux: Faux | undefined;

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createModels();
      models.setProvider(anthropicProvider());
      if (import.meta.env.DEV) {
        const { createFaux } = await import("./pi-run-faux.ts");
        this.#faux = createFaux();
        models.setProvider(this.#faux.provider);
      }
      this.#installTools(
        (await this.ctx.storage.get<ServerTools>(TOOLS_KEY)) ?? {}
      );
      return Harness.open(
        storage,
        {
          models,
          onReport: (error) =>
            console.warn(
              "PiRun: pi report",
              error instanceof Error ? error.message : String(error)
            ),
          registry: this.registry,
          // The scripted model fails on purpose, and a retry would only slow that check down.
          settings: { retry: { ...RETRY, enabled: !this.#faux } },
        },
        context
      );
    },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  #installTools(tools: ServerTools) {
    // The tools are those of the newest run's agent: a server it no longer has goes.
    for (const serverKey of this.#installed) {
      if (!(serverKey in tools)) {
        this.registry.uninstall({ name: `mcp-${serverKey}` });
        this.#installed.delete(serverKey);
      }
    }
    for (const [serverKey, list] of Object.entries(tools)) {
      this.#installed.add(serverKey);
      this.registry.install({
        name: `mcp-${serverKey}`,
        tools: mcpToolRegistrations(serverKey, list, async () => {
          const servers = await this.ctx.storage.get<Servers>(SERVERS_KEY);
          const server = servers?.[serverKey];
          if (!server) {
            throw new Error(`MCP server ${serverKey} is not configured`);
          }
          return server;
        }),
      });
    }
  }

  async #listAndInstallTools(input: CloudStart) {
    const lists = await Promise.all(
      Object.entries(input.mcpServers).map(
        async ([serverKey, server]) =>
          [serverKey, await listMcpTools(server)] as const
      )
    );
    const tools: ServerTools = Object.fromEntries(lists);
    await this.ctx.storage.put(TOOLS_KEY, tools);
    this.#installTools(tools);
  }

  #modelRef(model: string): { id: string; provider: string } {
    if (this.#faux && model === "faux") {
      const fauxModel: Model<string> = this.#faux.getModel();
      return { id: fauxModel.id, provider: this.#faux.provider.id };
    }
    return { id: model, provider: ANTHROPIC };
  }

  #port(): PiPort {
    const session = this.harness.session();
    return {
      abort: (operationId) => session.abort(operationId),
      busy: () => session.busy(),
      entriesFrom: async (start) => {
        // The whole transcript, not `session.messages()`: that is the model's context, and compaction cuts it.
        const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
        const entries: EntryRecord[] = [];
        let cursor: Cursor | undefined;
        do {
          // biome-ignore lint/performance/noAwaitInLoops: each page needs the cursor of the one before
          const page = await root.entries(
            {
              minEntryId: Number(start) as EntryRecord["id"],
              order: "ascending",
            },
            ENTRY_PAGE,
            cursor,
            BACKGROUND_CONTEXT
          );
          entries.push(...page.items);
          cursor = page.next;
        } while (cursor);
        return entries;
      },
      entryOf: async (operationId) => {
        const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
        // `storage()` is marked internal, and PiHarness itself looks submissions up this way.
        const record = await (await this.harness.storage()).submissionByRequest(
          root.id,
          operationId,
          BACKGROUND_CONTEXT
        );
        return record?.type === "input" && record.entry !== undefined
          ? String(record.entry)
          : undefined;
      },
      setModel: async (model) => {
        // The scripted model exists only once the harness has opened.
        await this.harness.pi();
        await session.setModel(this.#modelRef(model));
      },
      submit: async (text, options) => {
        const receipt = await session.submit(text, options);
        return { accepted: receipt.accepted };
      },
      wait: (operationId) => session.wait(operationId),
      watch: async (onChange) => {
        const stream = await session.events();
        stream.start(async (events) => {
          if (events.some((event) => COMMIT_EVENTS.has(event.type))) {
            await onChange();
          }
        });
        return () => stream.stop();
      },
    };
  }

  #runCore() {
    this.#core ??= (() => {
      const { runs } = compose(this.env, import.meta.env.DEV).services;
      return createRunCore({
        complete: (runId, result) =>
          runs.completeRun(SYSTEM_PRINCIPAL, runId, result),
        heartbeat: (runId) => runs.heartbeatRun(SYSTEM_PRINCIPAL, runId),
        ingest: (runId, events) =>
          runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, events),
        installTools: (input) => this.#listAndInstallTools(input),
        pi: this.#port(),
        statusOf: async (runId) =>
          (await runs.getRun(SYSTEM_PRINCIPAL, runId)).status,
        storage: this.ctx.storage,
      });
    })();
    return this.#core;
  }

  /** Lifecycle calls this when the object starts, and again after an eviction. */
  onStart(): void {
    this.#runCore()
      .resume()
      .catch((error: unknown) => {
        console.error("PiRun: resuming runs failed", error);
      });
  }

  // The calls below are RPC from the Worker, through `pi-run-port.ts`.

  async startRun(input: CloudStart): Promise<void> {
    await this.lifecycle.start();
    await this.#runCore().start(input);
  }

  async cancelRun(runId: string): Promise<void> {
    await this.lifecycle.start();
    await this.#runCore().cancel(runId);
  }
}
