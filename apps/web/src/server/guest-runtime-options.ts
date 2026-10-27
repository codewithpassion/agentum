import type { Database } from "@repo/db";
import {
  cloudModelFor,
  findCloudModel,
  parseModelRef,
} from "@repo/services/cloud/models";
import { guestAgentPolicy } from "@repo/services/live-guests/agent-policy";
import {
  createDurableGuestRuntime,
  type GuestRunnerPort,
} from "@repo/services/live-guests/durable-runtime";
import type { ManagedKeysService } from "@repo/services/managed/keys";
import type { ModelKeysService } from "@repo/services/model-keys";
export const guestRuntimeOptions = (input: {
  db: Database;
  runner?: GuestRunnerPort;
  managedKeys: Pick<ManagedKeysService, "resolve">;
  modelKeys: Pick<ModelKeysService, "resolve">;
}) => ({
  authorizeGuestGrant: guestAgentPolicy(
    input.db,
    async (model, workspaceId) => {
      if (!(input.runner && findCloudModel(model))) {
        return false;
      }
      const ref = parseModelRef(cloudModelFor(model));
      const key =
        ref.provider === "anthropic"
          ? await input.managedKeys.resolve(workspaceId)
          : await input.modelKeys.resolve(workspaceId, ref.provider);
      return Boolean(key);
    }
  ),
  guestAdapter: input.runner
    ? createDurableGuestRuntime(input.runner)
    : undefined,
  guestRuntimeReady: (runtime: string) =>
    Boolean(input.runner) && runtime === "cloud",
});
