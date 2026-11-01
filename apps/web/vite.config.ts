import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// An e2e deployment (scripts/e2e/a2a-*.ts) keeps its D1 database, Durable
// Objects and R2 files in its own folder, and opens no inspector port, because
// several of them start at once and would race for port 9229.
const stateDir = process.env.HM_STATE_DIR;

const config = defineConfig({
  plugins: [
    devtools(),
    cloudflare({
      ...(stateDir ? { inspectorPort: false } : {}),
      persistState: stateDir ? { path: stateDir } : true,
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
  // Vite answers CORS preflights itself and refuses the "null" origin of a
  // sandboxed artifact, so an app's POST to /api/* never reached the Worker in
  // dev. The Worker answers them, as in production.
  server: { cors: false },
});

export default config;
