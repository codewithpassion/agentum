# agentum

A [Turborepo](https://turborepo.com) monorepo, managed with Bun workspaces.

## Apps

- [`apps/web`](apps/web) — the [TanStack Start](https://tanstack.com/start) front end, deployed on Cloudflare Workers. See its [README](apps/web/README.md) for architecture and setup.

## Develop

```bash
bun install
bun run dev
```

Commands at the root run across all apps via [Turborepo](https://turborepo.com):

- `bun run dev` — start all apps in dev mode
- `bun run build` — build all apps
- `bun run deploy` — build and deploy all apps
- `bun run preview` — preview production builds
- `bun run check` / `bun run fix` — lint/format the whole repo with [Ultracite](https://ultracite.ai)

To run a command for a single app, use turbo's filter flag, e.g. `bunx turbo run dev --filter=web`, or `cd apps/web && bun run dev`.
