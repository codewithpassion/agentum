# X.9 review

Round 1 at 08e76c1: clean, no must-fix. Check, test and build pass.

## Nits left

- `error` is masked but not shortened. It can be up to 10,000 characters (`runs.ts`), and C4 asks for a short message.
- `readRun` calls `canSeeRun` and then `runs.getRun`, which applies the same visibility rule twice.
- A run id longer than 200 characters answers 400, not 404.
- No test for the `offered`, `waiting` and `cancelled` mappings.

## Beyond scope

- A `runId` on `run.*` frames of `/api/desk/stream` (optional in the task) was not built, so flightdex keeps polling every 2 s.

## For Dom

- The task's live staging check (send a controller message through the desk API, read it back until `reply` is set) is the controller's, after deploy.
