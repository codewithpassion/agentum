import { defineConfig } from "drizzle-kit";

// `bun run generate` writes plain SQL migrations here. They are applied by
// wrangler (`wrangler d1 migrations apply DB`), not by drizzle-kit, so this
// config needs no database credentials.
export default defineConfig({
  dialect: "sqlite",
  out: "./migrations",
  schema: "./src/schema.ts",
});
