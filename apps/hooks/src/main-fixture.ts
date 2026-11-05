import { fakePorts } from "@repo/app-gateway/fakes";
import { defineHooksMain } from "@repo/app-gateway/hooks-rpc";

const ports = fakePorts();
let calls = 0;
const errors: { entry: string; message: string }[] = [];
ports.startRun = async () => ({ runId: "run" });
ports.grants.read = async () => ({
  hosts: ["approved.test"],
  secretRules: async () => [
    {
      header: "Authorization",
      headerValue: "Bot fixture-secret",
      name: "BOT",
      value: "fixture-secret",
    },
  ],
});
export const HooksMain = defineHooksMain(() => {
  calls += 1;
  return {
    ports,
    recordError: (_target, entry, error) => {
      errors.push({
        entry,
        message: error instanceof Error ? error.message : String(error),
      });
      return Promise.resolve();
    },
  };
});
export default {
  fetch() {
    return Response.json({ calls, errors });
  },
};
