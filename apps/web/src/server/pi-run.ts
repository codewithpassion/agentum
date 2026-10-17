import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import {
  type Cursor,
  createRegistry,
  type EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import { CLOUD_LEASE_MS } from "@repo/services/cloud/lease";
import { cloudModelFor } from "@repo/services/cloud/models";
import type { CloudStart } from "@repo/services/cloud/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { compose } from "./compose.ts";
import { createRunCore, type PiPort, SERVERS_KEY } from "./pi-run-core.ts";
import { workspaceKeyStore } from "./pi-run-credentials.ts";
import { RunLeaseAlarm } from "./pi-run-lease.ts";
import {
  mcpToolRegistrations,
  type ServerTools,
  syncMcpTools,
  throttled,
  toolChanges,
} from "./pi-run-mcp.ts";
import { createCloudModels } from "./pi-run-models.ts";

const TOOLS_KEY = "mcp-tools";
/** The workspace of the session. An id, not a secret: the model key is read again for each model request. */
const WORKSPACE_KEY = "workspace";
const ENTRY_PAGE = 500;
const ANTHROPIC = "anthropic";
const RETRY = { baseDelayMs: 1000, enabled: true, maxRetries: 3 };
/** A failing tool call refreshes the tool lists at most this often. */
const REFRESH_GAP_MS = 30_000;
const COMMIT_EVENTS = new Set([
  "entry_appended",
  "message_end",
  "tool_execution_end",
]);

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
  /** The tool lists now in the registry, by server key. */
  #installed: ServerTools = {};
  /** The servers of the newest run that reached a sync. A start syncs before it stores them, so storage can lag. */
  #servers: Servers | undefined;
  /** Syncs take turns: two that overlap could install an older list over a newer one. */
  #syncing: Promise<unknown> = Promise.resolve();
  #faux: Faux | undefined;
  #composed: ReturnType<typeof compose> | undefined;

  /**
   * The workspace's Anthropic key, read from the workspace secrets store for
   * each model request and never kept: it is not in this object's storage and
   * not in a field.
   */
  readonly #credentials = workspaceKeyStore(async () => {
    const workspaceId = await this.ctx.storage.get<string>(WORKSPACE_KEY);
    if (!workspaceId) {
      return null;
    }
    const key = await this.#services().managedKeys.resolve(workspaceId);
    return key?.apiKey ?? null;
  });

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createCloudModels(this.#credentials);
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

  /** Moves the lease of the active runs from an alarm, so it outlives this object being down. */
  readonly lease = new RunLeaseAlarm(() => this.#runCore().beat());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.lease);

  /** Installs the servers whose list differs from the registry's, and removes the ones that are gone. */
  #installTools(tools: ServerTools) {
    const { install, uninstall } = toolChanges(this.#installed, tools);
    for (const serverKey of uninstall) {
      this.registry.uninstall({ name: `mcp-${serverKey}` });
    }
    for (const serverKey of install) {
      this.registry.install({
        name: `mcp-${serverKey}`,
        tools: mcpToolRegistrations(
          serverKey,
          tools[serverKey] ?? [],
          async () => {
            const servers = await this.ctx.storage.get<Servers>(SERVERS_KEY);
            const server = servers?.[serverKey];
            if (!server) {
              throw new Error(`MCP server ${serverKey} is not configured`);
            }
            return server;
          },
          undefined,
          // A failed call may mean the server's tools changed: look again.
          this.#refreshTools
        ),
      });
    }
    this.#installed = tools;
  }

  /**
   * Lists the servers and installs what changed. A server that cannot be
   * listed keeps the tools it had, so one down connector does not stop the run.
   * Without `servers` it uses the newest ones, read when its turn comes, so a
   * refresh queued behind a start never installs the run before it.
   */
  #syncTools(servers?: Servers): Promise<void> {
    const sync = this.#syncing.then(async () => {
      this.#servers = servers ?? this.#servers;
      const current =
        this.#servers ?? (await this.ctx.storage.get<Servers>(SERVERS_KEY));
      if (!current) {
        return;
      }
      const tools = await syncMcpTools(
        current,
        this.#installed,
        undefined,
        (serverKey, error) =>
          console.warn(
            `PiRun: MCP server ${serverKey} did not list its tools`,
            error instanceof Error ? error.message : String(error)
          )
      );
      await this.ctx.storage.put(TOOLS_KEY, tools);
      this.#installTools(tools);
    });
    this.#syncing = sync.catch(() => undefined);
    return sync;
  }

  /** Looks at the newest run's servers again, at most once per REFRESH_GAP_MS and never twice at a time. */
  readonly #refreshTools = throttled(() => this.#syncTools(), {
    minGapMs: REFRESH_GAP_MS,
  });

  #modelRef(model: string): { id: string; provider: string } {
    if (this.#faux && model === "faux") {
      const fauxModel: Model<string> = this.#faux.getModel();
      return { id: fauxModel.id, provider: this.#faux.provider.id };
    }
    return { id: cloudModelFor(model), provider: ANTHROPIC };
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

  #services() {
    this.#composed ??= compose(this.env, import.meta.env.DEV);
    return this.#composed.services;
  }

  #runCore() {
    this.#core ??= (() => {
      const { runs } = this.#services();
      return createRunCore({
        complete: (runId, result) =>
          runs.completeRun(SYSTEM_PRINCIPAL, runId, result),
        heartbeat: (runId) =>
          runs.heartbeatRun(SYSTEM_PRINCIPAL, runId, {
            leaseMs: CLOUD_LEASE_MS,
          }),
        ingest: (runId, events) =>
          runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, events),
        installTools: (input) => this.#syncTools(input.mcpServers),
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
      .then(async () => {
        await this.lease.schedule();
        // The lists stored before this wake may be old. With no active run there is nothing to look at.
        if (await this.ctx.storage.get(SERVERS_KEY)) {
          this.#refreshTools();
        }
      })
      .catch((error: unknown) => {
        console.error("PiRun: resuming runs failed", error);
      });
  }

  // The calls below are RPC from the Worker, through `pi-run-port.ts`.

  async startRun(input: CloudStart): Promise<void> {
    await this.ctx.storage.put(WORKSPACE_KEY, input.run.workspaceId);
    await this.lifecycle.start();
    await this.#runCore().start(input);
    await this.lease.schedule();
  }

  async cancelRun(runId: string): Promise<void> {
    await this.lifecycle.start();
    await this.#runCore().cancel(runId);
  }
}
