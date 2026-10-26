import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  COMPUTER_STATUSES,
  MACHINE_ROLES,
  MACHINE_STATUSES,
} from "../shared.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A machine belongs to one workspace and can hold two roles: `agent_host` (the
 * daemon) and `computer` (a client an agent drives). The relay alarm writes
 * `status`, which is the daemon's presence.
 */
export const machines = sqliteTable("machines", {
  // JSON, the daemon's.
  capabilities: text("capabilities").notNull(),
  // JSON `{ desktop, os, arch, workdir, clientVersion }` the computer client
  // sent in its hello. Null until a computer role is enrolled and connects.
  computerCapabilities: text("computer_capabilities"),
  computerLastSeenAt: text("computer_last_seen_at"),
  // Presence of the computer role. Null when the machine has no computer role.
  computerStatus: text("computer_status", { enum: COMPUTER_STATUSES }),
  createdAt: createdAt(),
  // The daemon's credential, the hash of a bearer token. A computer-only machine
  // gets `computer-only:` plus 32 random bytes nobody is shown. A SHA-256 hash is
  // lowercase hex, so no bearer token hashes to it, the machine has no usable
  // daemon credential, and the machines service reads the prefix to leave
  // `agent_host` out of its `roles`. Computer credentials live in
  // `machine_credentials`, never here.
  credentialHash: text("credential_hash").notNull(),
  // Clerk user who enrolled the machine.
  enrolledBy: text("enrolled_by").notNull(),
  id: id(),
  lastSeenAt: text("last_seen_at"),
  name: text("name").notNull(),
  // Set when the daemon could not get a separate agent user.
  singleUser: integer("single_user", { mode: "boolean" }).notNull(),
  status: text("status", { enum: MACHINE_STATUSES }).notNull(),
  workspaceId: workspaceId().references(() => workspaces.id),
});

/** Single use, 15 minutes. */
export const machineEnrollTokens = sqliteTable(
  "machine_enroll_tokens",
  {
    createdAt: createdAt(),
    // Clerk user who minted the token. Becomes `machines.enrolled_by`.
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at").notNull(),
    id: id(),
    // Set to add the `computer` role to this existing machine. Null mints a new one.
    machineId: text("machine_id").references(() => machines.id),
    machineName: text("machine_name").notNull(),
    // The role the code enrols. `agent_host` is the daemon.
    role: text("role", { enum: MACHINE_ROLES }).notNull().default("agent_host"),
    tokenHash: text("token_hash").notNull(),
    usedAt: text("used_at"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [uniqueIndex("machine_enroll_tokens_hash_unique").on(t.tokenHash)]
);

/**
 * A credential for one role of a machine. Holds `computer` credentials only:
 * the daemon's stays in `machines.credential_hash`. `credential_hash` is the
 * SHA-256 of an `hm_mach_` bearer token, so a lookup by hash finds the machine
 * and its role.
 */
export const machineCredentials = sqliteTable(
  "machine_credentials",
  {
    createdAt: createdAt(),
    credentialHash: text("credential_hash").notNull(),
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    role: text("role", { enum: MACHINE_ROLES }).notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("machine_credentials_hash_unique").on(t.credentialHash)]
);
