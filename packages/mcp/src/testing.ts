/**
 * Test helpers: an in-memory client connected to a server. Only `*.test.ts`
 * imports this.
 */
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type McpServer,
} from "@modelcontextprotocol/server";

/** Connects `server` to a client over the SDK's linked in-memory transports. */
export const connectClient = async (
  server: McpServer
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "harbourmaster-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

/** The text parts of a tool result, joined. */
export const textOf = (result: {
  content?: { text?: string; type: string }[];
}): string =>
  (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
