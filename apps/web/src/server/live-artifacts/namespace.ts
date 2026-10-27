import type { LiveRoomScope } from "@repo/services/live-artifacts/service";
import type { ArtifactRoom } from "./production-room";

export const roomName = (scope: LiveRoomScope) =>
  JSON.stringify([scope.workspaceId, scope.artifactId]);
export const roomStub = async (
  namespace: DurableObjectNamespace<ArtifactRoom>,
  scope: LiveRoomScope
) => {
  const stub = namespace.get(namespace.idFromName(roomName(scope)));
  await stub.bindScope(scope);
  return stub;
};
