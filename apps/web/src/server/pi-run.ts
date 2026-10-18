import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import {
  type Cursor,
  createRegistry,
  type EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import { cloudEnvironmentOf } from "@repo/services/cloud/environment";
import { CLOUD_LEASE_MS } from "@repo/services/cloud/lease";
import { cloudModelError, cloudModelFor } from "@repo/services/cloud/models";
import type { CloudStart } from "@repo/services/cloud/types";
import { isServiceError } from "@repo/services/errors";
import { agentHomePath, ensureAgentHome } from "@repo/services/library/home";
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
import type { LinuxVm } from "./linux-vm/vm-port.ts";
import { vmSkillSandbox } from "./linux-vm/vm-skill-sandbox.ts";
import { VM_SCRIPT_TEXTS } from "./linux-vm/vm-tools.ts";
import {
  placeInputFiles,
  placeSkills,
  withPlacedPaths,
} from "./linux-vm/vm-workdir.ts";
import {
  createRunCore,
  type PiPort,
  type RunRef,
  SERVERS_KEY,
} from "./pi-run-core.ts";
import { workspaceKeyStore } from "./pi-run-credentials.ts";
import {
  filesExtension,
  inputContent,
  type RunFilesPort,
  uploadOutputs,
} from "./pi-run-files.ts";
import { RunLeaseAlarm } from "./pi-run-lease.ts";
import {
  type McpSessions,
  mcpToolRegistrations,
  type ServerTools,
  syncMcpTools,
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

import { dynamicWorkerSandbox } from "./skill-scripts/dynamic-worker-sandbox.ts";
import {
  type ScriptSecrets,
  skillScriptsExtension,
} from "./skill-scripts/run-skill-script.ts";
import { skillVersionFiles } from "./skill-scripts/skill-version-files.ts";

const TOOLS_KEY = "mcp-tools";
/** The workspace of the session. An id, not a secret: the model key is read again for each model request. */
const WORKSPACE_KEY = "workspace";
/** The newest run of the session. Its principal reads and writes the library for Pi's file tools, which know no run of their own. */
const RUN_KEY = "run";
/** The slug of the agent of the newest run: its library home is `agents/<slug>`. */
const AGENT_SLUG_KEY = "agent-slug";
/** The skills of the run that loaded them last, with that run: a tool call knows no run of its own. The text is read again on each call. */
const SKILLS_KEY = "skills";
/** The agent id, stored only when the agent runs in a Linux VM: the VM is named by it, so every session of the agent shares one VM. Absent means the isolate. */
const VM_KEY = "linux-vm";
/** The run an input file belongs to, so `read_input_file` reads it as that run. */
const inputFileKey = (fileId: string) => `input-file:${fileId}`;
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
        // The import sits here, in the branch itself, so a production build drops the module.
        const { devToolsExtension } = await import("./pi-run-dev-tools.ts");
        const firstOpen = this.#faux === undefined;
        this.#faux = createFaux();
        models.setProvider(this.#faux.provider);
        if (firstOpen) {
          this.registry.install(devToolsExtension(this.ctx.storage));
        }
      }
      this.#installTools(
        (await this.ctx.storage.get<ServerTools>(TOOLS_KEY)) ?? {}
      );
      this.#switchEnvironment(await this.ctx.storage.get<string>(VM_KEY));
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

  /** Moves the lease of the active runs from an alarm, so it outlives this object being down. */
  readonly lease = new RunLeaseAlarm(() => this.#runCore().beat());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.lease);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `read_input_file` is the same for every run.
    this.registry.install(filesExtension((fileId) => this.#readInput(fileId)));
    this.registry.install(libraryToolsExtension(() => this.#agentSlug()));
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
   * and the environment follow. The VM is named by the agent id.
   */
  #switchEnvironment(agentId: string | undefined) {
    this.#vm = agentId ? durableVm(this.env.LINUX_VM, agentId) : undefined;
    installEnvironmentTools(
      this.registry,
      this.#vm ? "linux-vm" : "isolate",
      () => this.#agentSlug()
    );
  }

  /** Stores which environment the agent of this run asks for, and switches to it. */
  async #selectEnvironment(input: CloudStart) {
    const inVm = cloudEnvironmentOf(input.agent.runtimeConfig) === "linux-vm";
    if (inVm) {
      await this.ctx.storage.put(VM_KEY, input.run.agentId);
    } else {
      await this.ctx.storage.delete(VM_KEY);
    }
    this.#switchEnvironment(inVm ? input.run.agentId : undefined);
  }

  #agentSlug() {
    return this.ctx.storage.get<string>(AGENT_SLUG_KEY);
  }

  /** The isolate's agent keeps its files in its library folder, made on the first run. */
  async #ensureHome(input: CloudStart) {
    const run = runRefOf(input);
    const ops = bindLibraryOps(this.#services().library, principalOf(run));
    await ensureAgentHome(ops, input.agent.slug);
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
    const { files, library } = this.#services();
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
      readLibrary: async (path) => {
        const principal = principalOf(await whichRun());
        try {
          return (await library.read(principal, path)).bytes;
        } catch (error) {
          if (isServiceError(error) && error.code === "not_found") {
            return null;
          }
          throw error;
        }
      },
      upload: async ({ bytes, mime, name }) => {
        const principal = principalOf(await whichRun());
        const record = await files.upload(principal, {
          body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
          mime,
          name,
        });
        return { id: record.id };
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
          env: granted.env,
          mask: granted.masker.mask,
          proxy: granted.proxy.length > 0,
        };
      },
    };
  }

  /** The message as the model receives it. With a VM, the input files are also put in its workdir. */
  async #inputContent(run: RunRef, text: string, fileIds: readonly string[]) {
    const port = this.#filesPort(() => Promise.resolve(run));
    const vm = this.#vm;
    if (!vm) {
      return inputContent(text, fileIds, port);
    }
    const placed: { bytes: Uint8Array; name: string }[] = [];
    const content = await inputContent(text, fileIds, {
      ...port,
      download: async (fileId) => {
        const file = await port.download(fileId);
        placed.push(file);
        return file;
      },
    });
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
        inputOf: async (run, text, fileIds) => {
          await Promise.all(
            fileIds.map((id) => this.ctx.storage.put(inputFileKey(id), run))
          );
          return await this.#inputContent(run, text, fileIds);
        },
        installSkills: (input) => this.#loadAndInstallSkills(input),
        installTools: (input) => this.#syncTools(input.mcpServers),
        // The scripted model exists only in dev, and not yet when a run starts, so `#faux` cannot be asked.
        modelError: (model) =>
          import.meta.env.DEV && model === "faux"
            ? undefined
            : cloudModelError(model),
        outputsOf: async (run, text) => {
          // The isolate's file tools start in the agent's home, so a relative marker is read from there.
          const slug = this.#vm ? undefined : await this.#agentSlug();
          return uploadOutputs(
            text,
            this.#filesPort(() => Promise.resolve(run)),
            slug ? agentHomePath(slug) : undefined
          );
        },
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
    await this.ctx.storage.put(RUN_KEY, runRefOf(input));
    await this.ctx.storage.put(AGENT_SLUG_KEY, input.agent.slug);
    await this.#selectEnvironment(input);
    if (!this.#vm) {
      await this.#ensureHome(input);
    }
    await this.lifecycle.start();
    await this.#runCore().start(input);
    await this.lease.schedule();
  }

  async cancelRun(runId: string): Promise<void> {
    await this.lifecycle.start();
    await this.#runCore().cancel(runId);
  }
}
