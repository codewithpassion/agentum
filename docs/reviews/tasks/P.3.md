# P.3 review record

Branch task/P.3-provider-aware-model-catalogue. Two rounds.

## Round 1 (ff9d3c6): must-fix

- The form offers the three OpenRouter models, but a run on one fails with a bare `no_model` until P.4 lands. `#modelRef` in `apps/web/src/server/pi-run.ts` still sends every model to Anthropic. Not changed in P.3: P.4 depends on P.3 and its task file names that change. The reviewer called it must-fix only if P.3 reaches a deployed environment before P.4.
- The `providerKeys` router held its own loop and type guard, against the thin-router rule. Fixed in b8973fd: the flags moved into `configuredProviders` on the model-keys service, with service tests, and the router is one call.

## Round 2 (b8973fd): clean

The fix commit has no must-fix. `check`, `test`, `build` and the `drizzle` bundle grep pass.

## Nits left

- `parseModelRef` keeps the id after the colon as written, so `openrouter: z-ai/glm-5.3` (with a space) parses but is not in the catalogue. The test name "trims surrounding spaces" does not pin that. A case for it would stop the trim coming back.
- `configuredProviders` repeats the two read-check lines from `status`. Its "every provider needs a flag" throw exists only to narrow the `Object.fromEntries` type.
- The "Choose a model" placeholder in the agent form is a raw `<option>`, while the grouped entries use `NativeSelectOption`.
- A failing `agents.providerKeys` call fails the whole New agent page and the agent Settings tab, though the flag only marks a provider in the picker.
- The cloud runtime description in the form says the agent "sees attached images", which is wrong for the text-only GLM-5.3.

## Beyond the scope

- Show each model's input (text, or text and image) in the picker. The catalogue has the field, and nothing in the UI uses it yet. P.4 makes text-only models list image files by name.
- P.2 adds its own `modelKeys` router. Once it is in, `agents.providerKeys` could move there.

## For Dom

No steps need Dom's accounts or dashboards. Merge P.3 and P.4 together, or hold the deploy of P.3 until P.4 is in: until then the three new models are selectable and fail at run start. The form's "Settings, Model providers" text points at the page P.2 adds.
