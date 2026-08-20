import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const config = defineConfig(({ mode }) => ({
  plugins: [
    devtools(),
    cloudflare({
      // Production builds deploy without the Worker Loader (Cloudflare rejects
      // the `experimental` flag in deployed Workers); dev and e2e keep it.
      configPath:
        mode === "production" ? "./wrangler.production.jsonc" : undefined,
      viteEnvironment: { name: "ssr" },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
}));

export default config;
