// biome-ignore-all lint/performance/noNamespaceImport: protocol libraries expose namespaced APIs.
import * as encoding from "lib0/encoding";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

const doc = new Y.Doc();
let provider: YProvider;
let flush: () => void;
Object.assign(window, {
  clientId: doc.clientID,
  connect(ticket: string, room = "test", clientId?: number) {
    if (clientId !== undefined) {
      doc.clientID = clientId;
    }
    provider = new YProvider("localhost:18987", room, doc, {
      disableBc: true,
      params: { ticket },
      party: "live",
    });
  },
  connected: () => provider.wsconnected,
  disconnect: () => provider.disconnect(),
  forge(id: number) {
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, id);
    encoding.writeVarUint(update, 999_999);
    encoding.writeVarString(
      update,
      JSON.stringify({ user: { name: "Forged other" } })
    );
    const packet = encoding.createEncoder();
    encoding.writeVarUint(packet, 1);
    encoding.writeVarUint8Array(packet, encoding.toUint8Array(update));
    provider.ws?.send(encoding.toUint8Array(packet));
  },
  identity: (name: string) =>
    provider.awareness.setLocalStateField("user", {
      color: "forged",
      kind: "forged",
      name,
    }),
  insert: (text: string) => doc.getText("test").insert(0, text),
  offlineInsert: (index: number, text: string) => {
    const { ws } = provider;
    if (!ws) {
      throw new Error("socket missing");
    }
    const send = ws.send.bind(ws);
    const queued: ArrayBufferLike[] = [];
    ws.send = (data) => {
      queued.push(data as ArrayBufferLike);
    };
    doc.getText("test").insert(index, text);
    flush = () => {
      ws.send = send;
      for (const data of queued) {
        send(data);
      }
    };
  },
  reconnect: () => flush(),
  relative: (index: number) =>
    Array.from(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(doc.getText("test"), index)
      )
    ),
  states: () => [...provider.awareness.getStates().entries()],
  text: () => doc.getText("test").toString(),
});
