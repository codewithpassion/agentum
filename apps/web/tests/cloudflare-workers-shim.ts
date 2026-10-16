import { mock } from "bun:test";

/**
 * workerd provides `cloudflare:workers`, and `bun test` does not. This mock
 * stands in for it so Durable Object classes can load under test. Preloaded by
 * `bunfig.toml`.
 */

class DurableObject {
  ctx: unknown;
  env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

class WorkerEntrypoint {}

mock.module("cloudflare:workers", () => ({
  DurableObject,
  env: {},
  WorkerEntrypoint,
}));
