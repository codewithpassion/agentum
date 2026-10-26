import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { OAUTH_CLIENT_ACCESS } from "../shared.ts";
import { workspaces } from "./workspaces.ts";

/**
 * OAuth clients (Clerk OAuth applications) seen by `/mcp`. Clerk's access
 * tokens carry no audience, so a token only proves the user consented to some
 * app on the Clerk instance. A client does nothing here until a workspace
 * member approves it. `client_id` is unique across workspaces, and the row
 * names the workspace an OAuth principal acts in. A row with no `access` and
 * no `revoked_at` is pending; with `revoked_at` it is revoked.
 */
export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    // Null until approved.
    access: text("access", { enum: OAUTH_CLIENT_ACCESS }),
    approvedAt: text("approved_at"),
    clientId: text("client_id").notNull(),
    // When the client was first seen.
    createdAt: createdAt(),
    // Clerk user whose token first showed the client.
    firstSeenBy: text("first_seen_by").notNull(),
    id: id(),
    lastUsedAt: text("last_used_at"),
    // The application's name as Clerk reports it. Chosen by whoever registered it.
    name: text("name"),
    revokedAt: text("revoked_at"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [uniqueIndex("oauth_clients_client_id_unique").on(t.clientId)]
);
