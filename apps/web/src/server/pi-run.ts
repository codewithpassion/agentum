import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import {
  type Cursor,
  createRegistry,
  type EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import type { Masker } from "@repo/protocol/masker";
import { CLOUD_LEASE_MS } from "@repo/services/cloud/lease";
import {
  cloudModelError,
  cloudModelFor,
  findCloudModel,
  parseModelRef,
} from "@repo/services/cloud/models";
import { networkAccessOf } from "@repo/services/cloud/network";
import type { CloudStart } from "@repo/services/cloud/types";
import { isServiceError } from "@repo/services/errors";
import { agentHomePath } from "@repo/services/library/home";
import { librarySyncScope } from "@repo/services/library/sync-paths";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { compose } from "./compose.ts";
import { LIBRARY_MOUNT } from "./library-bash/run.ts";
import { createLibraryEnv } from "./library-env/library-env.ts";
import { bindLibraryOps } from "./library-env/library-ops.ts";
import { libraryToolsExtension } from "./library-env/library-tools.ts";
import { durableVm } from "./linux-vm/durable-vm.ts";
import { installEnvironmentTools } from "./linux-vm/environment-tools.ts";
import { createVmEnv } from "./linux-vm/vm-env.ts";
import {
  libraryCopyOf,
  syncLibraryIn,
  syncLibraryOut,
  syncLibraryPaths,
} from "./linux-vm/vm-library-sync.ts";
import type { LinuxVm } from "./linux-vm/vm-port.ts";
import { vmSkillSandbox } from "./linux-vm/vm-skill-sandbox.ts";
import { VM_SCRIPT_TEXTS } from "./linux-vm/vm-tools.ts";
import {
  placeInputFiles,
  placeSkills,
  withPlacedPaths,
} from "./linux-vm/vm-workdir.ts";
import { takeDesktopScreenshot } from "./mcp/computer-ports.ts";
import {
  DESKTOP_SCREENSHOT_TOOL,
  installComputer,
  type StoredComputer,
} from "./pi-run-computer.ts";
import {
  createRunCore,
  type PiPort,
  type RunRef,
  runsInVm,
  SERVERS_KEY,
} from "./pi-run-core.ts";
import { workspaceKeyStore } from "./pi-run-credentials.ts";
import { deltaPublisher, type LivePartial } from "./pi-run-deltas.ts";
import {
  filesExtension,
  inputContent,
  type RunFilesPort,
} from "./pi-run-files.ts";
import { createGate, gateExtension } from "./pi-run-gate.ts";
import { repeatGuardExtension } from "./pi-run-guard.ts";
import { prepareHome } from "./pi-run-home.ts";
import { RunLeaseAlarm } from "./pi-run-lease.ts";
import {
  type McpSessions,
  mcpToolOrigins,
  mcpToolRegistrations,
  type ServerTools,
  syncMcpTools,
  type ToolOrigin,
  throttled,
  toolChanges,
} from "./pi-run-mcp.ts";
import { createCloudModels } from "./pi-run-models.ts";
import {
  loadSkills,
  type SkillSummary,
  type SkillsPort,
  skillsExtension,
} from "./pi-run-skills.ts";
import { createStartQueue } from "./pi-run-start.ts";
import { RunStartAlarm } from "./pi-run-start-alarm.ts";
import { streamPublisher } from "./session-stream-port.ts";

import { dynamicWorkerSandbox } from "./skill-scripts/dynamic-worker-sandbox.ts";
import type { RunScriptDeps } from "./skill-scripts/run-script.ts";
import {
  type ScriptSecrets,
  skillScriptsExtension,
} from "./skill-scripts/run-skill-script.ts";
import { skillVersionFiles } from "./skill-scripts/skill-version-files.ts";
import { ownHostsOf } from "./web-fetch/guard.ts";
import type { SecretPlaceholder } from "./web-fetch/pi-tool.ts";
import { runWebFetcher } from "./web-fetch/run-fetcher.ts";
import type { WebFetcher } from "./web-fetch/types.ts";

const TOOLS_KEY = "mcp-tools";
/** The workspace of the session. An id, not a secret: the model key is read again for each model request. */
const WORKSPACE_KEY = "workspace";
/** The newest run of the session. Its principal reads and writes the library for Pi's file tools, which know no run of their own. */
const RUN_KEY = "run";
/** Whether the newest run is a dry run, so the gate skips what is not read-only. */
const DRY_RUN_KEY = "dry-run";
/** The id of the session this object serves, as the stream names it. Stored beside the run, because the run reference has no session. */
const SESSION_KEY = "session";
/** The slug of the agent of the newest run: its library home is `agents/<slug>`. */
const AGENT_SLUG_KEY = "agent-slug";
/** The library path of the newest run's task folder, which the isolate's prompt names. Absent for a dry run. */
const TASK_FOLDER_KEY = "task-folder";
/** The skills of the run that loaded them last, with that run: a tool call knows no run of its own. The text is read again on each call. */
const SKILLS_KEY = "skills";
/** The agent id, stored only when the agent runs in a Linux VM: the VM is named by it, so every session of the agent shares one VM. Absent means the isolate. */
const VM_KEY = "linux-vm";
/** The agent's computer as the newest run's `CloudStart` gave it, so the wake path installs the same computer tools and prompt paragraph. Absent means none. */
const COMPUTER_KEY = "computer";
/** Whether the isolate's agent may reach the network, so the wake path installs the same `web_fetch` the run did. Absent means true. */
const NETWORK_KEY = "network-access";
/** The run an input file belongs to, so `read_input_file` reads it as that run. */
const inputFileKey = (fileId: string) => `input-file:${fileId}`;
const ENTRY_PAGE = 500;
const RETRY = { baseDelayMs: 1000, enabled: true, maxRetries: 3 };
/** A failing tool call refreshes the tool lists at most this often. */
const REFRESH_GAP_MS = 30_000;
const COMMIT_EVENTS = new Set([
  "entry_appended",
  "message_end",
  "tool_execution_end",
]);

/** The view the deltas are read from, shared by the followed runs. */
interface SharedDeltas {
  close: Promise<() => void>;
  users: number;
}

interface StoredSkills {
  run: RunRef;
  skills: SkillSummary[];
}

/** The services see the run as its own principal, and decide what it may read and write. */
const principalOf = (run: RunRef): Principal => ({
  agentId: run.agentId,
  kind: "run",
  runId: run.runId,
  workspaceId: run.workspaceId,
});

const runRefOf = (input: CloudStart): RunRef => ({
  agentId: input.run.agentId,
  runId: input.run.id,
  workspaceId: input.run.workspaceId,
});

type Servers = CloudStart["mcpServers"];
type Faux = ReturnType<typeof import("./pi-run-faux.ts")["createFaux"]>;

/**
 * One session's cloud runs on Pi Durable (`docs/reviews/spike-pi-durable.md`).
 * The object is named by the Agentum session id. Each run is one Pi
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
  /** The server and tool name of each installed MCP tool, by Pi's name: the gate keys its rules on them. */
  #origins = new Map<string, ToolOrigin>();
  /** The MCP sessions this object holds, by server URL. Listing and tool calls share them. */
  readonly #mcpSessions: McpSessions = new Map();
  /** The servers of the newest run that reached a sync. A start syncs before it stores them, so storage can lag. */
  #servers: Servers | undefined;
  /** Syncs take turns: two that overlap could install an older list over a newer one. */
  #syncing: Promise<unknown> = Promise.resolve();
  #faux: Faux | undefined;
  /** The agent's Linux VM, when the agent runs in one. */
  #vm: LinuxVm | undefined;
  #composed: ReturnType<typeof compose> | undefined;
  /** The push of the VM's library changes that runs now, from the lease alarm. */
  #checkpointing: Promise<void> | undefined;
  #streams: ReturnType<typeof streamPublisher> | undefined;
  /** The view the deltas are read from, and how many followed runs share it. */
  #deltas: SharedDeltas | undefined;

  /**
   * The workspace's provider keys, read from the workspace secrets store for
   * each model request and never kept: it is not in this object's storage and
   * not in a field.
   */
  readonly #credentials = workspaceKeyStore(async (provider) => {
    const workspaceId = await this.ctx.storage.get<string>(WORKSPACE_KEY);
    if (!workspaceId) {
      return null;
    }
    if (provider === "anthropic") {
      const key = await this.#services().managedKeys.resolve(workspaceId);
      return key?.apiKey ?? null;
    }
    const key = await this.#services().modelKeys.resolve(workspaceId, provider);
    return key?.apiKey ?? null;
  });

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createCloudModels(this.#credentials);
      if (import.meta.env.DEV) {
        const { createFaux } = await import("./pi-run-faux.ts");
        // The import sits here, in the branch itself, so a production build drops the module.
        const { devToolsExtension } = await import("./pi-run-dev-tools.ts");
        const firstOpen = this.#faux === undefined;
        this.#faux = createFaux();
        models.setProvider(this.#faux.provider);
        if (firstOpen) {
          this.registry.install(devToolsExtension(this.ctx.storage));
        }
      }
      // The environment's tools go in before the connectors', as on a fresh start. Pi lists the tools in
      // install order, and a different order after an eviction makes it re-declare every tool.
      this.#switchEnvironment(
        await this.ctx.storage.get<string>(VM_KEY),
        (await this.ctx.storage.get<boolean>(NETWORK_KEY)) ?? true
      );
      this.#installComputer(
        await this.ctx.storage.get<StoredComputer>(COMPUTER_KEY)
      );
      this.#installTools(
        (await this.ctx.storage.get<ServerTools>(TOOLS_KEY)) ?? {}
      );
      const skills = await this.ctx.storage.get<StoredSkills>(SKILLS_KEY);
      if (skills) {
        this.#applySkills(skills);
      }
      return Harness.open(
        storage,
        {
          env: () => this.#executionEnv(),
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

  /** Asks a person before a ruled tool runs, and carries the `ask_user` tool. */
  readonly #gate = createGate({
    isDryRun: async () =>
      (await this.ctx.storage.get<boolean>(DRY_RUN_KEY)) ?? false,
    maskerOf: async () => {
      const run = await this.#storedRun("the dry-run gate");
      return await this.#services().secrets.maskerFor(
        run.workspaceId,
        run.agentId
      );
    },
    originOf: (piName) => this.#origins.get(piName),
    recordSkip: (runId, skip) =>
      this.#services().runs.recordDryRunSkip(SYSTEM_PRINCIPAL, runId, skip),
    requests: {
      needsApproval: (input) =>
        this.#services().requests.needsApproval(SYSTEM_PRINCIPAL, input),
      open: (input) => this.#services().requests.open(SYSTEM_PRINCIPAL, input),
      outcome: (requestId) =>
        this.#services().requests.outcome(SYSTEM_PRINCIPAL, requestId),
    },
    runIdOf: async () => (await this.#storedRun("the request gate")).runId,
    serverKeys: () => Object.keys(this.#installed),
  });

  /**
   * Moves the lease of the active runs from an alarm, so it outlives this object
   * being down. The same beat makes every call that waits for an answer read its
   * request again, so an answer whose RPC was missed is found within one beat.
   */
  readonly lease = new RunLeaseAlarm(() => {
    this.#gate.checkOpen();
    return this.#runCore().beat();
  });

  /**
   * The starts the platform handed over, saved until the claim and the setup
   * are done. They run from an alarm, not in the request that asked, so a
   * browser that leaves cannot strand a run that was already accepted.
   */
  readonly #starts = createStartQueue({
    begin: async (input) => {
      await this.lifecycle.start();
      await this.#runCore().start(input);
      await this.lease.schedule();
    },
    claim: async (runId) => {
      try {
        await this.#services().runs.claimRun(SYSTEM_PRINCIPAL, runId, {
          leaseMs: CLOUD_LEASE_MS,
        });
        return "claimed";
      } catch (error) {
        if (isServiceError(error) && error.code === "conflict") {
          // A run that is running: the queue decides whether our own earlier claim made it so.
          const run = await this.#services().runs.getRun(
            SYSTEM_PRINCIPAL,
            runId
          );
          // A run that waits for an answer is still the one we claimed.
          return run.status === "running" || run.status === "waiting"
            ? "running"
            : "conflict";
        }
        throw error;
      }
    },
    fail: async (runId, error) => {
      await this.#services().runs.completeRun(SYSTEM_PRINCIPAL, runId, {
        error,
        status: "failed",
      });
    },
    prepare: (input) => this.#prepareRun(input),
    storage: this.ctx.storage,
    waiting: async (runId) => {
      const { status } = await this.#services().runs.getRun(
        SYSTEM_PRINCIPAL,
        runId
      );
      return status === "queued" || status === "offered";
    },
  });

  /** Works the saved starts from an alarm that survives this object being evicted. */
  readonly startAlarm = new RunStartAlarm(() => this.#starts.work());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.lease)
    .use(this.startAlarm);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `read_input_file` is the same for every run.
    this.registry.install(filesExtension((fileId) => this.#readInput(fileId)));
    this.registry.install(
      libraryToolsExtension(
        () => this.#agentSlug(),
        () => this.ctx.storage.get<string>(TASK_FOLDER_KEY)
      )
    );
    this.registry.install(repeatGuardExtension());
    this.registry.install(gateExtension(this.#gate));
  }

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
          this.#refreshTools,
          this.#mcpSessions
        ),
      });
    }
    this.#installed = tools;
    this.#origins = mcpToolOrigins(tools);
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
          ),
        this.#mcpSessions
      );
      await this.ctx.storage.put(TOOLS_KEY, tools);
      this.#installTools(tools);
    });
    this.#syncing = sync.catch(() => undefined);
    return sync;
  }

  /**
   * Makes the session run in its agent's Linux VM, or in the isolate when
   * `agentId` is undefined: the file and shell tools, the skill script backend
   * and the environment follow. The VM is named by the agent id. `networkEnabled`
   * is the isolate's network setting, which decides its `web_fetch` tool.
   */
  #switchEnvironment(agentId: string | undefined, networkEnabled: boolean) {
    this.#vm = agentId ? durableVm(this.env.LINUX_VM, agentId) : undefined;
    installEnvironmentTools(
      this.registry,
      this.#vm ? "linux-vm" : "isolate",
      () => this.#agentSlug(),
      () => libraryCopyOf(this.ctx.storage),
      {
        enabled: networkEnabled,
        fetcherOf: () => this.#webFetcher(),
        placeholdersOf: () => this.#secretPlaceholders(),
      },
      this.#runScriptDeps(),
      () => this.ctx.storage.get<string>(TASK_FOLDER_KEY),
      () => this.ctx.storage.get<StoredComputer>(COMPUTER_KEY)
    );
  }

  /**
   * Gives the session the computer tools when the agent's computer has a desktop,
   * and takes them out otherwise. They go in right after the environment's tools,
   * the same place on a start and on a wake, so Pi does not re-declare the tools.
   */
  #installComputer(computer: StoredComputer | undefined) {
    installComputer(this.registry, computer, {
      screenshot: async (machineId) =>
        takeDesktopScreenshot(this.#compose().relay, machineId, {
          agentId: (await this.#storedRun(DESKTOP_SCREENSHOT_TOOL)).agentId,
          kind: "agent",
        }),
      takeover: this.#gate.requestTakeover,
    });
  }

  /**
   * The secrets of the newest run's agent that it may use as placeholders, read
   * when the prompt renders. Names and hosts only. A failed read is logged
   * without its error, and the prompt renders without the list.
   */
  async #secretPlaceholders(): Promise<readonly SecretPlaceholder[]> {
    try {
      const run = await this.ctx.storage.get<RunRef>(RUN_KEY);
      if (!run) {
        return [];
      }
      return await this.#services().secrets.placeholdersFor(
        run.workspaceId,
        run.agentId
      );
    } catch {
      console.warn(
        "PiRun: reading the secret placeholders for the prompt failed"
      );
      return [];
    }
  }

  /** Stores which environment and network setting the agent of this run asks for, and switches to them. */
  async #selectEnvironment(input: CloudStart) {
    const inVm = runsInVm(input);
    if (inVm) {
      await this.ctx.storage.put(VM_KEY, input.run.agentId);
    } else {
      await this.ctx.storage.delete(VM_KEY);
    }
    const networkEnabled = networkAccessOf(input.agent.runtimeConfig);
    await this.ctx.storage.put(NETWORK_KEY, networkEnabled);
    this.#switchEnvironment(
      inVm ? input.run.agentId : undefined,
      networkEnabled
    );
  }

  /**
   * The fetcher for a `web_fetch` call. The run is read when the call comes,
   * because the tool is installed before any run is known.
   */
  async #webFetcher(): Promise<WebFetcher> {
    const run = await this.#storedRun("web_fetch");
    return runWebFetcher({
      ownHosts: ownHostsOf(this.env.PUBLIC_BASE_URL),
      run,
      services: this.#services(),
      via: "web_fetch",
    });
  }

  /** The newest run, read when a tool call comes. `tool` names the call in the error. */
  async #storedRun(tool: string): Promise<RunRef> {
    const run = await this.ctx.storage.get<RunRef>(RUN_KEY);
    if (!run) {
      throw new Error(`${tool} needs a run, and none is stored`);
    }
    return run;
  }

  /** What `run_script` needs from this session. Each part is read when its call comes. */
  #runScriptDeps(): RunScriptDeps {
    return {
      homeOf: () => this.#agentHome(),
      read: async (path) => {
        const run = await this.#storedRun("run_script");
        try {
          return (await this.#services().library.read(principalOf(run), path))
            .bytes;
        } catch (error) {
          if (isServiceError(error) && error.code === "not_found") {
            return null;
          }
          throw error;
        }
      },
      record: async (entry) => {
        const run = await this.#storedRun("run_script");
        await this.#services().library.recordScript(principalOf(run), entry);
      },
      sandboxOf: async () => {
        const run = await this.#storedRun("run_script");
        const home = await this.#agentHome();
        const network =
          (await this.ctx.storage.get<boolean>(NETWORK_KEY)) ?? true;
        return dynamicWorkerSandbox(this.env.LOADER, undefined, () =>
          this.ctx.exports.ScriptHost({
            props: {
              home,
              network,
              run: {
                agentId: run.agentId,
                runId: run.runId,
                workspaceId: run.workspaceId,
              },
            },
          })
        );
      },
    };
  }

  #agentSlug() {
    return this.ctx.storage.get<string>(AGENT_SLUG_KEY);
  }

  /** The agent's library home, `agents/<slug>`, or "" for the root when no agent is stored. */
  async #agentHome(): Promise<string> {
    const slug = await this.#agentSlug();
    return slug ? agentHomePath(slug) : "";
  }

  /** The isolate's agent keeps its files in its library folder, made on the first run. A dry run makes none. */
  async #ensureHome(input: CloudStart) {
    const run = runRefOf(input);
    const ops = bindLibraryOps(this.#services().library, principalOf(run));
    await prepareHome(ops, input.agent.slug, input.run.dryRun);
  }

  /**
   * Copies the agent's library roots (home, wiki and grants, each with its
   * mode) into the VM's working copy when a run starts. A failed sync is
   * logged and the run goes on: the agent still has the library tools.
   */
  async #syncLibraryIn(input: CloudStart) {
    if (!this.#vm) {
      return;
    }
    await syncLibraryIn({
      ops: bindLibraryOps(
        this.#services().library,
        principalOf(runRefOf(input))
      ),
      roots: input.library
        ? input.library.roots
        : librarySyncScope(input.agent.slug, []),
      slug: input.agent.slug,
      storage: this.ctx.storage,
      taskFolder: input.library?.taskFolder,
      vm: this.#vm,
    });
  }

  /**
   * Sends the agent's changes in the VM's working copy back to the library,
   * when a run ends just before the VM checkpoint and while it runs from the
   * lease alarm (`waitMs: 0`, see `#checkpointLibrary`). A change that lost to a
   * newer library file is kept as a conflict copy and logged as a
   * `library.conflict` event on the run. Never throws.
   */
  async #syncLibraryOut(runId: string, waitMs?: number) {
    const stored = await this.ctx.storage.get<RunRef>(RUN_KEY);
    if (!(this.#vm && stored)) {
      return;
    }
    // Every run of the session is the same agent in the same workspace.
    const principal = principalOf({ ...stored, runId });
    const { library } = this.#services();
    await syncLibraryOut({
      ops: bindLibraryOps(library, principal),
      recordConflict: (conflict) => library.recordConflict(principal, conflict),
      runId,
      storage: this.ctx.storage,
      vm: this.#vm,
      ...(waitMs === undefined ? {} : { waitMs }),
    });
  }

  /**
   * The push from the lease alarm. It runs apart from the beat, so a slow walk
   * of the VM never holds up the alarm's other jobs, and one push runs at a
   * time. It gives way to a sync that holds the lock and tries again on the
   * next beat.
   */
  #checkpointLibrary(runId: string): Promise<void> {
    if (this.#vm && !this.#checkpointing) {
      const push = this.#syncLibraryOut(runId, 0)
        .catch((error: unknown) => {
          console.warn(
            "PiRun: the library checkpoint failed",
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => {
          this.#checkpointing = undefined;
        });
      this.#checkpointing = push;
      this.ctx.waitUntil(push);
    }
    return Promise.resolve();
  }

  /** The environment of Pi's file and shell tools: the VM, or the library for the newest run. Without a run there is no principal, so no library environment. */
  async #executionEnv() {
    const agentId = await this.ctx.storage.get<string>(VM_KEY);
    const run = await this.ctx.storage.get<RunRef>(RUN_KEY);
    if (this.#vm && agentId) {
      // The VM's commands get the agent's `env` secrets, and their output is masked.
      return createVmEnv({
        agentId,
        secrets: run ? this.#scriptSecrets(run) : undefined,
        vm: this.#vm,
      });
    }
    if (!run) {
      return;
    }
    const slug = await this.#agentSlug();
    return createLibraryEnv({
      // Relative paths land in the agent's home. A session from before the slug was stored starts at the root.
      cwd: slug ? `${LIBRARY_MOUNT}/${agentHomePath(slug)}` : undefined,
      ops: bindLibraryOps(this.#services().library, principalOf(run)),
      workspaceId: run.workspaceId,
    });
  }

  /** An input file, read as the run that has it. */
  async #readInput(fileId: string) {
    const run = await this.ctx.storage.get<RunRef>(inputFileKey(fileId));
    if (!run) {
      throw new Error(`${fileId} is not an input file of this session`);
    }
    return this.#filesPort(() => Promise.resolve(run)).download(fileId);
  }

  #skillsPort(run: RunRef): SkillsPort {
    const { runSkills } = this.#services();
    return {
      list: () => runSkills.list(principalOf(run), run.runId),
      read: (path) => runSkills.read(principalOf(run), run.runId, path),
    };
  }

  #filesPort(whichRun: () => Promise<RunRef>): RunFilesPort {
    const { files } = this.#services();
    return {
      download: async (fileId) => {
        const principal = principalOf(await whichRun());
        const { body, file } = await files.download(principal, fileId);
        return {
          bytes: new Uint8Array(await new Response(body).arrayBuffer()),
          mime: file.mime,
          name: file.name,
        };
      },
    };
  }

  /** Installs the skills extension for these skills, in place of the one before. */
  #applySkills({ run, skills }: StoredSkills) {
    const port = this.#skillsPort(run);
    this.registry.install(skillsExtension(skills, port));
    this.registry.install(
      skillScriptsExtension(
        skills,
        port,
        this.#scriptSandbox(run),
        this.#scriptSecrets(run),
        undefined,
        this.#vm ? VM_SCRIPT_TEXTS : undefined,
        skillVersionFiles(this.#services().skillsStore, principalOf(run))
      )
    );
  }

  /** Where this session's skill scripts run: the Linux VM, or a Dynamic Worker. */
  #scriptSandbox(run: RunRef) {
    return this.#vm
      ? vmSkillSandbox(this.#vm)
      : dynamicWorkerSandbox(this.env.LOADER, () =>
          // The isolate's requests go through here, where the rules add the credentials. Ids only: the entrypoint reads the secrets itself.
          this.ctx.exports.SecretsOutbound({ props: run })
        );
  }

  /**
   * The agent's secrets for one script or shell call, read fresh each time so a
   * grant that changed between two calls applies. `env` secrets go into the
   * isolate or the VM's command, `proxy` ones are added by the outbound
   * entrypoint, and the answer is masked so a value a script printed never
   * reaches the model.
   */
  #scriptSecrets(run: RunRef): ScriptSecrets {
    return {
      forRun: async () => {
        const { secrets } = this.#services();
        const granted = await secrets.resolveForAgent(
          run.workspaceId,
          run.agentId
        );
        try {
          await secrets.announceDelivery(run, {
            env: Object.keys(granted.env),
            proxy: granted.proxy,
            surface: "cloud",
          });
        } catch (error) {
          // A log that failed must not stop the script.
          console.warn(
            `PiRun: recording the secrets delivery for run ${run.runId} failed`,
            error instanceof Error ? error.name : "unknown error"
          );
        }
        return {
          // The run's own id, so a skill script can name its run in a report.
          env: { ...granted.env, HM_RUN_ID: run.runId },
          mask: granted.masker.mask,
          proxy: granted.proxy.length > 0,
        };
      },
    };
  }

  /** The message as the model receives it. With a VM, the input files are also put in its workdir. */
  async #inputContent(
    run: RunRef,
    text: string,
    fileIds: readonly string[],
    model: string
  ) {
    const port = this.#filesPort(() => Promise.resolve(run));
    const vm = this.#vm;
    // A model not in the catalogue, such as the dev-only faux model, keeps images.
    const acceptsImages =
      findCloudModel(model)?.input.includes("image") ?? true;
    if (!vm) {
      return inputContent(text, fileIds, port, acceptsImages);
    }
    const placed: { bytes: Uint8Array; name: string }[] = [];
    const content = await inputContent(
      text,
      fileIds,
      {
        ...port,
        download: async (fileId) => {
          const file = await port.download(fileId);
          placed.push(file);
          return file;
        },
      },
      acceptsImages
    );
    try {
      return withPlacedPaths(content, await placeInputFiles(vm, placed));
    } catch (error) {
      console.warn(
        `PiRun: input files of run ${run.runId} not placed in the VM: ${error instanceof Error ? error.message : String(error)}`
      );
      return content;
    }
  }

  async #loadAndInstallSkills(input: CloudStart) {
    const run = runRefOf(input);
    const skills = await loadSkills(this.#skillsPort(run));
    const stored: StoredSkills = { run, skills };
    await this.ctx.storage.put(SKILLS_KEY, stored);
    this.#applySkills(stored);
    if (this.#vm) {
      await placeSkills(this.#vm, skills, this.#skillsPort(run), run.runId);
      await this.#routeVmEgress(this.#vm, run);
    }
  }

  /**
   * Tells the VM which hosts the agent has a `proxy` secret for, so the
   * platform adds the header to HTTPS requests to them outside the VM. Only
   * ids and hosts go in. The VM still works without it, and a request to such a
   * host then goes out without the credential. Sessions of one agent share the
   * VM and its one egress, so it belongs to the run that set it last, and the
   * audit of a credential added outside the VM names that run.
   */
  async #routeVmEgress(vm: LinuxVm, run: RunRef) {
    try {
      const { proxy } = await this.#services().secrets.resolveForAgent(
        run.workspaceId,
        run.agentId
      );
      const hosts = [...new Set(proxy.flatMap((entry) => entry.hosts))];
      if (hosts.length > 0) {
        await vm.setEgress({ hosts, run });
      }
    } catch (error) {
      console.warn(
        `PiRun: routing the VM's proxied hosts for run ${run.runId} failed`,
        error instanceof Error ? error.name : "unknown error"
      );
    }
  }

  /**
   * Snapshots the VM's home folder when a run completes. Never throws: a failed
   * checkpoint is logged and must not fail or retry the completion.
   */
  async #checkpointVm(runId: string) {
    const vm = this.#vm;
    if (!vm) {
      return;
    }
    try {
      const agentId = await this.ctx.storage.get<string>(VM_KEY);
      const workspaceId = await this.ctx.storage.get<string>(WORKSPACE_KEY);
      if (!(agentId && workspaceId)) {
        console.warn(
          `PiRun: checkpointing the VM after run ${runId} skipped, the session has no VM ids`
        );
        return;
      }
      await vm.checkpoint({ agentId, runId, workspaceId });
    } catch (error) {
      console.warn(
        `PiRun: checkpointing the VM after run ${runId} failed`,
        error instanceof Error ? error.message : String(error)
      );
    }
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
    return parseModelRef(cloudModelFor(model));
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
      setInstructions: async (instructions) => {
        // `configure` follows the same rule as `setModel`: a change applies from the next request.
        const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
        await root.configure(
          { instructions: instructions || null },
          BACKGROUND_CONTEXT
        );
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
        const stopDeltas = await this.#streamDeltas();
        return async () => {
          stopDeltas();
          await stream.stop();
        };
      },
    };
  }

  /**
   * Sends the partial answer Pi commits every 100 ms to the session stream as
   * `delta` frames, labelled with the newest run like the rest of this object.
   * Only the text of the answer is read: tool arguments and output reach the
   * stream as the stored, scrubbed `tool.call` and `tool.result` events. One
   * view serves every run followed at the same time, because a second would
   * send the same text again. Returns the function that stops this caller's
   * share, and the view closes with the last one. A failure never reaches the
   * run.
   */
  async #streamDeltas(): Promise<() => void> {
    if (!this.#deltas) {
      const created: SharedDeltas = {
        close: Promise.resolve(() => undefined),
        users: 0,
      };
      this.#deltas = created;
      created.close = this.#openDeltas(() => {
        if (this.#deltas === created) {
          this.#deltas = undefined;
        }
      });
    }
    const shared = this.#deltas;
    shared.users += 1;
    const close = await shared.close;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      shared.users -= 1;
      if (shared.users === 0) {
        if (this.#deltas === shared) {
          this.#deltas = undefined;
        }
        close();
      }
    };
  }

  /** Opens the view the deltas are read from. Resolves to the function that closes it, and never rejects. */
  async #openDeltas(onFailure: () => void): Promise<() => void> {
    try {
      let current:
        | { publisher: ReturnType<typeof deltaPublisher>; runId: string }
        | undefined;
      const publisherOfNewestRun = async () => {
        const run = await this.ctx.storage.get<RunRef>(RUN_KEY);
        const sessionId = await this.ctx.storage.get<string>(SESSION_KEY);
        if (!(run && sessionId)) {
          return;
        }
        if (current?.runId !== run.runId) {
          current = {
            publisher: this.#deltaPublisher(run, sessionId),
            runId: run.runId,
          };
        }
        return current.publisher;
      };
      const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
      const view = await root.viewState(BACKGROUND_CONTEXT);
      // Returning the promise makes Pi wait for one offer before the next.
      const unsubscribe = view.subscribe(async (value) => {
        const live = value.docs["pi.live"] as LivePartial | undefined;
        if (live?.generation?.message !== undefined) {
          await (await publisherOfNewestRun())?.offer(live);
        }
      });
      return () => {
        unsubscribe();
        view.dispose();
      };
    } catch (error) {
      // The next caller tries again.
      onFailure();
      console.warn(
        "PiRun: streaming partial text failed",
        error instanceof Error ? error.name : "unknown error"
      );
      return () => undefined;
    }
  }

  #deltaPublisher(run: RunRef, sessionId: string) {
    this.#streams ??= streamPublisher(this.env.SESSION_STREAM, (work) =>
      this.ctx.waitUntil(work)
    );
    const streams = this.#streams;
    // Read once for the run. A failed read is dropped, and the next frame reads again.
    let masker: Promise<Masker | null> | undefined;
    return deltaPublisher({
      clock: () => Date.now(),
      maskerOf: () => {
        masker ??= this.#services()
          .secrets.maskerFor(run.workspaceId, run.agentId)
          .catch((error: unknown) => {
            masker = undefined;
            throw error;
          });
        return masker;
      },
      publish: (frame) => streams.publish(sessionId, frame),
      runId: run.runId,
    });
  }

  #compose() {
    // A library write from the object announces itself after the write returns.
    this.#composed ??= compose(
      this.env,
      import.meta.env.DEV,
      (work) => this.ctx.waitUntil(work),
      this.ctx.exports
    );
    return this.#composed;
  }

  #services() {
    return this.#compose().services;
  }

  #runCore() {
    this.#core ??= (() => {
      const { runs } = this.#services();
      return createRunCore({
        // The VM's library changes go back to the library while the run goes on, from the lease alarm. A no-op outside a VM.
        checkpointLibrary: (runId) => this.#checkpointLibrary(runId),
        complete: async (runId, result) => {
          // Before the run ends, so its library events come before run.finished. A retried completion syncs again, which sends nothing new.
          await this.#checkpointing;
          await this.#syncLibraryOut(runId);
          await runs.completeRun(SYSTEM_PRINCIPAL, runId, result);
          await this.#checkpointVm(runId);
        },
        heartbeat: (runId) =>
          runs.heartbeatRun(SYSTEM_PRINCIPAL, runId, {
            leaseMs: CLOUD_LEASE_MS,
          }),
        ingest: (runId, events) =>
          runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, events),
        inputOf: async (run, text, fileIds, model) => {
          await Promise.all(
            fileIds.map((id) => this.ctx.storage.put(inputFileKey(id), run))
          );
          return await this.#inputContent(run, text, fileIds, model);
        },
        installSkills: (input) => this.#loadAndInstallSkills(input),
        installTools: (input) => this.#syncTools(input.mcpServers),
        // The scripted model exists only in dev, and not yet when a run starts, so `#faux` cannot be asked.
        modelError: (model) =>
          import.meta.env.DEV && model === "faux"
            ? undefined
            : cloudModelError(model),
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
        // A start saved before an eviction is finished now.
        if (await this.#starts.hasPending()) {
          await this.startAlarm.schedule();
        }
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

  /**
   * Saves the start and returns. The claim and the setup run from the alarm
   * (`#prepareRun`, then the run core), because this call comes from a request
   * that the browser can cancel.
   */
  async startRun(input: CloudStart): Promise<void> {
    await this.lifecycle.start();
    await this.#starts.request(input);
    await this.startAlarm.schedule();
  }

  /** Points the object at the run's agent and brings its environment up, before Pi takes the run. */
  async #prepareRun(input: CloudStart): Promise<void> {
    await this.ctx.storage.put(WORKSPACE_KEY, input.run.workspaceId);
    await this.ctx.storage.put(RUN_KEY, runRefOf(input));
    await this.ctx.storage.put(DRY_RUN_KEY, input.run.dryRun);
    await this.ctx.storage.put(SESSION_KEY, input.run.sessionId);
    await this.ctx.storage.put(AGENT_SLUG_KEY, input.agent.slug);
    if (input.library?.taskFolder) {
      await this.ctx.storage.put(TASK_FOLDER_KEY, input.library.taskFolder);
    } else {
      await this.ctx.storage.delete(TASK_FOLDER_KEY);
    }
    if (input.computer) {
      await this.ctx.storage.put(COMPUTER_KEY, input.computer);
    } else {
      await this.ctx.storage.delete(COMPUTER_KEY);
    }
    await this.#selectEnvironment(input);
    this.#installComputer(input.computer);
    try {
      await this.#vm?.setRun(runRefOf(input));
    } catch (error) {
      console.warn(
        `PiRun: naming run ${input.run.id} to the VM failed`,
        error instanceof Error ? error.message : String(error)
      );
    }
    if (this.#vm) {
      await this.#syncLibraryIn(input);
    } else {
      await this.#ensureHome(input);
    }
  }

  /**
   * Library paths changed under a run of the session. A run in a Linux VM
   * pulls just those paths into its working copy, within the roots it started
   * with. An isolate reads the library directly, so it has nothing to do.
   */
  async libraryChanged(paths: string[]): Promise<void> {
    await this.lifecycle.start();
    const { storage } = this.ctx;
    const agentId = await storage.get<string>(VM_KEY);
    const run = await storage.get<RunRef>(RUN_KEY);
    if (!(agentId && run)) {
      return;
    }
    await syncLibraryPaths({
      ops: bindLibraryOps(this.#services().library, principalOf(run)),
      paths,
      storage,
      vm: this.#vm ?? durableVm(this.env.LINUX_VM, agentId),
    });
  }

  async cancelRun(runId: string): Promise<void> {
    await this.lifecycle.start();
    await this.#runCore().cancel(runId);
  }

  /**
   * A request of the run was closed (answered, expired). Wakes the call that
   * waits for it. An object that was evicted meanwhile has no waiter: its call
   * runs again on start and reads the request, so waking it is all this does.
   */
  async requestAnswered(_runId: string, requestId: string): Promise<void> {
    await this.lifecycle.start();
    this.#gate.answered(requestId);
  }
}
