import type { LinuxVm } from "./vm-port.ts";
import { VmFileError } from "./vm-port.ts";
import type { VmReply, VmSession } from "./vm-session.ts";

/** Turns a reply of the Durable Object back into a value or the file error it carried. */
const unwrap = async <T>(reply: Promise<VmReply<T>>): Promise<T> => {
  const settled = await reply;
  if (settled.ok) {
    return settled.value;
  }
  throw new VmFileError(settled.code, settled.message);
};

/**
 * The agent's Linux VM, reached through its Durable Object. The object is named
 * by the agent id, so sessions of one agent share one VM and one disk. When two
 * sessions write the same file, the last write wins.
 */
export const durableVm = (
  namespace: DurableObjectNamespace<VmSession>,
  agentId: string
): LinuxVm => {
  const stub = namespace.get(namespace.idFromName(agentId));
  return {
    exec: (input) => stub.exec(input),
    list: (path) => unwrap(stub.list(path)),
    mkdir: (path, options) => unwrap(stub.mkdir(path, options)),
    readFile: (path) => unwrap(stub.readFile(path)),
    remove: (path, options) => unwrap(stub.remove(path, options)),
    rename: (from, to) => unwrap(stub.rename(from, to)),
    setEgress: (egress) => stub.setEgress(egress),
    stat: (path) => unwrap(stub.stat(path)),
    writeFile: (path, bytes) => unwrap(stub.writeFile(path, bytes)),
  };
};
