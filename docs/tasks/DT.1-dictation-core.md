---
id: DT.1
title: Dictation component, service, and the main prompt boxes
milestone: DT
size: L
status: done
depends_on: []
branch: task/DT.1-dictation-core
lane: web
executor: codex
---

Spec: `docs/v3/dictation.md`. Requested by Dom on 5 Nov 2026.

## Scope
- `packages/services/src/dictation.ts`: `createDictationService` with `status`, `transcribe` and `polish`, plus the exported model constant (`asr: "nvidia/parakeet-tdt-0.6b-v3"`, `polish: "anthropic/claude-haiku-5.5"`). It uses the workspace's OpenRouter key from `model-keys.ts`. Build it in `composeWith` and add it to `Services`.
- tRPC router `dictation` (`status`, `transcribe`, `polish`, all `workspaceProcedure`), with per-user rate limits from the existing limiter.
- `apps/web/src/components/dictation/`: `useDictation`, `DictationButton` (mic, chevron mic picker, level indicator) and `DictationPreview` (inline ghost text), with the interactions in the spec: click to toggle, hold for push-to-talk, Ctrl+D tap or hold, Escape to cancel, read-only while dictating, polish then insert at the caret, raw fallback. Audio capture, WAV encoding and segmenting are pure helpers with tests.
- Wire it into `thread/composer-container.tsx` (assistant-ui composer) and `desk/new-task-dialog.tsx`.
- With no OpenRouter key, the mic is disabled, and its tooltip points to Settings, Model providers.

## Check
- Service tests: the key comes from the workspace, the request shape and model ids are right, no key means unavailable, a provider error is a short error, oversize or non-WAV audio is refused, and a non-member is refused.
- Helper tests: the WAV header and PCM16 encoding, segmenting at a pause and at 15 s, the polish fallback rules (timeout, length ratio, error).
- Component tests (happy-dom, mocked media): a click toggles, a hold of 250 ms or more is push-to-talk, Ctrl+D tap and hold with auto-repeat ignored, Escape cancels, the preview shows muted italic text, and the polished text is inserted at the caret.
- `bun run check && bun run test && bun run build`, and the bundle grep is clean.
- Controller: a real browser check on local dev with the OpenRouter key and a fake mic (Chrome `--use-file-for-fake-audio-capture`).

## Log
- 2026-11-05: opened at Dom's request. Dom chose the workspace key, Haiku through OpenRouter, members only, and Parakeet over Nemotron after the latency test.
- 2026-11-05: Codex implemented (e31eb025..f1ff637c). Opus review found 3 major and 6 minor; Codex fixed 8 in 46847883 (native-rate capture with resampling, failure recovery, preview growth, placeholder, mirror metrics, saved mic, RMS voice detection, tooltip). The reused rate limiters stay, noted as fragile. Merged as 6f12885b; check, test, build and bundle grep pass. The live browser check moves to staging, after Dom adds an OpenRouter key there.
