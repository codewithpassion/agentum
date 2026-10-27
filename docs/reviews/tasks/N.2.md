# N.2 review

## Verdicts

Round 1 at 6c5a9bf: not clean. The delete event was committed even when the guarded deletes did nothing, and the commit-versus-delete blob race was only narrowed.
Round 2 at f858b82: not clean. `migrateLibrary` stored blobs before its rows but not after.
Round 3 at de0ee65: clean.

## What changed

Skill delete: the blob removal is best effort and logged, and puts bytes back when a row points at them again. `publish` and `migrateLibrary` store their blobs again after the rows land, so one side always restores a shared blob. The live-run check runs inside every delete of the batch, with the agent ids read once. `onDeleted` retires the skill's `managed_skill_versions` rows and its Anthropic skills through `managed.retireSkill`. Connector delete refuses while an assigned agent has a live run, with the same guard, and its dialog says so and uses the shared `errorMessage`. `delete_connector` writes the `admin.action` event through `admin.audit`. The delete events are written after the delete is confirmed.

## Nits left

- If the event write fails after a delete committed, the delete reports an error. A crash between the two writes loses the event.
- An agent assigned between the first read and the batch is outside the guard.
- `retire` keeps rows after a failed Anthropic delete, but nothing retries, because the skill is gone. With no Anthropic key the rows go and the uploads stay.
- `onDeleted` runs inside the delete request, so a skill with many versions makes the delete slow.
- The second `storeBlobs` adds one R2 `exists` call per fresh file to a publish, and a throw there reports an error for a written version.
- `race.armed` in the blob race test does nothing. No test covers the store after `migrateLibrary`.
- The `delete_connector` audit payload holds the id, not the name.

## Ideas beyond scope

- Retry orphaned Anthropic uploads from a sweep of `managed_skill_versions` rows whose skill is gone.
- An MCP tool to list connectors, so `delete_connector` needs no id from the UI.

## Steps for Dom

None. The controller deletes the two pending-only `p5-loop` skills (owners `p5-glm53` and `p5-glm53-flash`) in the Dev Workspace on staging after deploy.
