import { DurableObject } from "cloudflare:workers";

// Placeholder for the per-machine relay (M0.0 spike): answers a ping from
// inside the Durable Object.
export class MachineRelay extends DurableObject<Env> {
  ping() {
    return { pong: true };
  }
}
