import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

/** Pinned so the suite never races a `bun run dev` already holding 3000. */
const PORT = 3100;
export const BASE_URL = `http://localhost:${PORT}`;
const SERVER_START_TIMEOUT_MS = 180_000;

export const STORAGE_STATE = "e2e/.auth/user.json";

const config = defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      dependencies: ["setup"],
      name: "chromium",
      testMatch: /.*\.e2e\.ts$/,
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
    },
  ],
  reporter: [["list"]],
  retries: process.env.CI ? 1 : 0,
  testDir: "e2e",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    // The migration is idempotent and covers a fresh `.wrangler` state dir,
    // without which every `/api` call fails on a missing table.
    //
    // `--mode e2e` is what keeps the suite off the real Anthropic API: the key
    // in `.env.local` reaches the Worker no matter what the environment says,
    // so the mode is the only switch a single run can flip
    // (see modules/anthropic/service.ts).
    command: `bun run db:migrate:local && bunx vite dev --mode e2e --port ${PORT} --strictPort`,
    reuseExistingServer: !process.env.CI,
    timeout: SERVER_START_TIMEOUT_MS,
    url: BASE_URL,
  },
  // The suite drives one shared workspace, so parallel workers would fight over
  // the sidebar and the message stream.
  workers: 1,
});

export default config;
