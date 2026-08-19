import { defineConfig } from "drizzle-kit";

// `out` must stay in sync with `d1_databases[0].migrations_dir` in
// wrangler.jsonc: drizzle-kit writes the SQL, wrangler applies it.
export default defineConfig({
  dialect: "sqlite",
  out: "./drizzle",
  schema: [
    "./src/modules/agents/schema.ts",
    "./src/modules/anthropic/schema.ts",
    "./src/modules/messaging/schema.ts",
    "./src/modules/connectors/schema.ts",
    "./src/modules/wiki/schema.ts",
  ],
});
