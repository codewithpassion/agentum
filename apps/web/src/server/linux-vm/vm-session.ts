import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup, Files } from "@cloudflare/sandbox";
import { createVmCore, type VmContainer, type VmProcess } from "./vm-core.ts";
import { type LinuxVm, VmFileError } from "./vm-port.ts";

/** The Worker's R2 bucket that holds the snapshots, under this prefix. */
const SNAPSHOT_BINDING = "FILES";
const SNAPSHOT_PREFIX = "vm-snapshots/";
const DEFAULT_IDLE_SECONDS = 180;
const INSTANCE = "standard-1";

/** What a call answers. A file error is a value, because an error thrown across RPC loses its code. */
export type VmReply<T> =
  | { ok: true; value: T }
  | { code: VmFileError["code"]; message: string; ok: false };

const reply = async <T>(task: Promise<T>): Promise<VmReply<T>> => {
  try {
    return { ok: true, value: await task };
  } catch (error) {
    if (error instanceof VmFileError) {
      return { code: error.code, message: error.message, ok: false };
    }
    throw error;
  }
};

const idleMsOf = (env: Env): number => {
  const seconds = Number(env.LINUX_VM_IDLE_SECONDS);
  return (
    (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_IDLE_SECONDS) *
    1000
  );
};

/**
 * One session's Linux VM: a Sandbox SDK container, named by the Harbourmaster
 * session id. The logic is in `vm-core.ts`. This class is the part only a real
 * Worker can run: the container, the Sandbox SDK's file and backup classes, and
 * the alarm. Nothing of the Worker's `env` goes into the container: it starts
 * with no environment variables and commands run with the ones they are given.
 */
export class VmSession extends DurableObject<Env> {
  readonly #core: ReturnType<typeof createVmCore>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { container } = ctx;
    if (!container) {
      throw new Error("VmSession needs a container, see wrangler.jsonc");
    }
    const vmContainer: VmContainer = {
      destroy: (reason) => container.destroy(reason),
      exec: async (command, options) =>
        (await container.exec(command, options)) as VmProcess,
      get running() {
        return container.running;
      },
      setInactivityTimeout: (ms) => container.setInactivityTimeout(ms),
      start: () => {
        container.start({
          enableInternet: true,
          image: container.images.base,
          instance: INSTANCE,
        });
        // A container that dies on its own (a bad image, an out of memory kill) says why only here.
        container.monitor().catch((error: unknown) => {
          // `destroy(reason)` rejects with its reason, a string: that is our own stop, not a failure.
          if (typeof error !== "string") {
            console.error(
              "VmSession: the container stopped",
              error instanceof Error ? error.message : String(error)
            );
          }
        });
      },
    };
    this.#core = createVmCore({
      backups: new DirectoryBackup(
        container,
        ctx.exports.DirectoryBackupGateway,
        { binding: SNAPSHOT_BINDING, prefix: SNAPSHOT_PREFIX }
      ),
      container: vmContainer,
      deleteAlarm: () => ctx.storage.deleteAlarm(),
      files: new Files(container),
      idleMs: idleMsOf(env),
      label: ctx.id.name ?? ctx.id.toString(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      storage: ctx.storage,
    });
    // A restarted object has lost the container's inactivity timeout, and the container would stop without a snapshot.
    ctx.blockConcurrencyWhile(() => this.#core.wake());
  }

  /** The platform calls this when an alarm set by the core comes due. */
  override alarm(): Promise<void> {
    return this.#core.alarm();
  }

  // The calls below are RPC from the PiRun Durable Object, through `durable-vm.ts`.

  exec(...args: Parameters<LinuxVm["exec"]>) {
    return this.#core.exec(...args);
  }

  list(...args: Parameters<LinuxVm["list"]>) {
    return reply(this.#core.list(...args));
  }

  mkdir(...args: Parameters<LinuxVm["mkdir"]>) {
    return reply(this.#core.mkdir(...args));
  }

  readFile(...args: Parameters<LinuxVm["readFile"]>) {
    return reply(this.#core.readFile(...args));
  }

  remove(...args: Parameters<LinuxVm["remove"]>) {
    return reply(this.#core.remove(...args));
  }

  rename(...args: Parameters<LinuxVm["rename"]>) {
    return reply(this.#core.rename(...args));
  }

  stat(...args: Parameters<LinuxVm["stat"]>) {
    return reply(this.#core.stat(...args));
  }

  writeFile(...args: Parameters<LinuxVm["writeFile"]>) {
    return reply(this.#core.writeFile(...args));
  }
}
