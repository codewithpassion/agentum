# TM.15 review: Dictation in the room composer

## Verdict

Round 1 at 789dfb95: clean. No must-fix findings. No fix rounds.

## Skipped

The browser check at both sizes is skipped here and left to the single browser pass after all tasks merge.

## Nits left

- The room composer is not a case in `components/composer/dictation-rollout.test.tsx`, so its press-and-stop behaviour has no stubbed-adapter test. Only rendering is tested.
- The new test in `mention-composer.test.tsx` uses the real tRPC adapter, so the button renders disabled. It never shows the button working with dictation available.
- Dictated text clears the mention list, but a later caret move can reopen it if the dictated words contain an "@". Probably harmless; the browser pass can confirm.

## Ideas beyond scope

Add the room composer to `dictation-rollout.test.tsx` with a stubbed adapter.

## Steps for Dom

None. Dictation needs an OpenRouter key in Settings, Model providers, as in every other prompt box.
