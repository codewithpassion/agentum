# KY.11 review

Task: Allowed tools for a catalogue app that has not been connected.

## Verdicts

Round 0, at a7486629: not clean. Two must-fix items.
- In the Allowed tools dialog's empty-cache branch, removing every name left a plain Save button, and the server stores an empty list as "every tool".
- Only the `AllowedNamesList` child was tested, not `AllowedToolsDialog`.

Round 1, at d2541ae4, on the fix commit only: clean. When no names are left the dialog says "No names left. Saving allows every tool." and the button reads "Allow every tool". `allowed-tools-dialog.test.tsx` covers the empty-cache branch, removal, Save and the null-list case.

Browser proof: pass at 1280x800 and 390x844, see `docs/reviews/tasks/KY.11/browser.md`.

## What changed

- The Allowed tools dialog lists the saved names with a Remove button each when the connector has no cached tool list. Save is disabled until a name is removed.
- Settings, Apps shows "N by default" plus "Tool list not fetched yet" for a catalogue connector that has never fetched its tools (`toolsFetchedAt` is null), and "Not fetched yet" when the catalogue lists no defaults. Other connectors show the cached count as before.
- The `settings/connectors` loader now returns `{ catalog, connectors }`. A failed catalogue read gives `catalog: null` and the page still loads.

## Nits left

- `allowed-tools-dialog.tsx`: `namesUnchanged` compares list lengths only. That holds while names can only be removed.
- `allowed-tools-dialog.test.tsx`: `hasButton` matches text only, `buttonNamed` also matches `aria-label`.
- `settings.connectors.tsx`: the catalogue `.catch` hides every catalogue error. The Tools column then falls back to "Not fetched yet".
- The route's loader and `ConnectorRow` have no test, only `ToolsCell` does.

## Beyond the scope

- "N by default" is the catalogue's default, not what any agent has. After an agent narrows its list, the Keys row and the Apps column differ by design. A per-agent summary on Apps would need its own task.
- A dialog for a connector whose tools were fetched stays as it was.

## Steps for Dom

None.
