// biome-ignore-all lint/performance/noNamespaceImport: protocol libraries expose namespaced APIs.
import * as encoding from "lib0/encoding";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

const doc = new Y.Doc();
let provider: YProvider;
Object.assign(window, {
  clientId: doc.clientID,
  connect(ticket: string) {
    provider = new YProvider("localhost:18987", "test", doc, {
      disableBc: true,
      params: { ticket },
      party: "live",
    });
  },
  connected: () => provider.wsconnected,
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
  states: () => [...provider.awareness.getStates().entries()],
  text: () => doc.getText("test").toString(),
});
