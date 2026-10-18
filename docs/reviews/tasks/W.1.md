# Review: W.1 Workspace instructions builder

## Verdicts

- Round 1 (f8e95c1): must-fix. With no scratch folder, the text said files outside home last one call, which contradicted the library line for the isolate.
- Round 2 (bbcd8b4): clean. The no-scratch text now says "home and the library" when the library is local.

## Nits left

- Managed gets "no scratch folder" and does not say the session has its own disk. The text is coherent but sparser than the draft.
- The draft's "under 1 GB in total" for the VM home is not in the builder, which has no input for it.
- With `homeIsLocal: false` and a local `library`, the home line says it is not on the agent's disk. No runtime uses that mix.
- A home path with a trailing slash renders as `agents/support/.`.

## Ideas beyond the scope

- Add an optional home size cap to the input if the 1 GB soft limit should show in the VM prompt.
- W.5 must make the isolate's cwd the home folder, or "Relative paths start here" is false for the isolate.

## Steps for Dom

None.
