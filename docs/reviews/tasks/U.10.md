# U.10 review

Branch `task/U.10-navigation-settings`.

## Verdict

Round 1 at cd4b9be: clean. No must-fix findings.

## Nits left

- `settings.model-providers.tsx`: the two `ProviderKeyForm`s each sit in an identical wrapper `div`. Harmless.
- `components/model-providers/provider-key-form.tsx` and `key-state.test.ts` import `./key-state` without the `.ts` extension, unlike the other new files.
- `ProviderKeyForm` runs `router.invalidate()` (inside `onSave`) before the "Key saved" toast. If the invalidate failed after the key was stored, the form would show an error. The old pages had the same ordering.

## Notes on the task file

- `routeTree.gen.ts` is tracked in git on main, not gitignored as the task says. The commit includes its regenerated version.
- `worker-configuration.d.ts` can be stale in a fresh worktree and break `typecheck` in server files. `bun run cf-typegen` in `apps/web` fixes it.

## Ideas beyond the scope

- The settings sub-nav could show the sidebar icons next to its items.
- The old `/connectors`, `/machines` and `/settings/managed-agents` redirects can go once no bookmark or external OAuth return still uses them.

## Steps for Dom

- Open Settings > Model providers with a real Anthropic key and a real OpenRouter key and save then remove each. Both providers reject fake keys, so the browser check only covered the error path ("did not accept that key") in the local run. The form logic is the code of the two old pages moved into one component.
