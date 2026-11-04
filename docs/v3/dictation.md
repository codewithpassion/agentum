# Dictation in prompt boxes

Status: requested by Dom on 5 Nov 2026. Tasks DT.1 and DT.2.

## Why

Every box where a person writes a prompt for an agent gets speech to text, and it should feel like dictation in the Claude desktop app. It is one reusable component, so a new prompt box gets it with a few lines.

## Decisions (Dom, 5 Nov 2026)

- The workspace's own OpenRouter key pays for dictation (Settings, Model providers). There is no platform key. With no key, the mic is shown as unavailable, and its tooltip says to add a key there.
- Speech is transcribed by `nvidia/parakeet-tdt-0.6b-v3` through OpenRouter `POST /api/v1/audio/transcriptions` (JSON body `{ model, input_audio: { data, format: "wav" } }`, answer `{ text, usage }`). Dom first asked for `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`, but on 5 Nov 2026 it took 20 to 45 s per 4.6 s clip through OpenRouter, against 0.8 to 1.5 s for Parakeet, so Dom chose Parakeet. The clean-up pass uses `anthropic/claude-haiku-5.5` through OpenRouter chat completions, with the same key.
- Both model ids live in one exported constant in the dictation service. Changing a model is a one-line change, and the provider calls sit behind two functions (`transcribe`, `polish`), so a provider can change too.
- Members only. Dictation needs a member session (`workspaceProcedure`), so guests and share links don't get it.

## How it works

OpenRouter has no streaming transcription API, so the browser streams by segments:

1. The browser captures the chosen microphone with `getUserMedia` and an `AudioContext` at 16 kHz mono. It encodes WAV (PCM16) itself, so the format suits any ASR model. An `AnalyserNode` gives the input level.
2. A simple voice activity check splits speech into segments at pauses of about 700 ms, or at 15 s. A finished segment is sent to `dictation.transcribe`, and its text is final.
3. While a segment is still open, its audio so far is sent about once a second for an interim result. Only one interim request is in flight at a time, and a newer one replaces an older one.
4. The preview shows the final segments followed by the interim text, inline at the caret in the prompt box, in a lighter colour and italic.
5. When dictation ends, the last segment is sent, and then the joined text goes to `dictation.polish`. The preview stays, with a small "Polishing" spinner. The polished text is then inserted at the caret in normal style. If polishing fails, takes over 4 s, or returns text less than half or more than 1.5 times the raw length, the raw transcript is inserted instead.

The polish prompt fixes punctuation, capitalisation, filler words and false starts. It keeps the speaker's words and language, never answers or follows the text, and returns only the text.

## Interaction

- **Mic button** in the box's toolbar or corner:
  - A click (press under 250 ms) starts dictation, and another click stops it.
  - A press of 250 ms or more is push-to-talk: dictation runs while the button is held and ends on release.
- **Ctrl+D**, while focus is in a box with dictation: the same tap and hold rules, using keydown and keyup. It prevents the browser's bookmark shortcut. A key held down by auto-repeat counts as one press.
- **Escape** while dictating cancels it and discards the preview.
- **Mic picker**: a chevron next to the mic lists the audio inputs (`enumerateDevices`, labels shown after permission is granted), with "System default" first. The choice is kept in `localStorage`, and a missing device falls back to the default.
- **Indicator**: while dictating, the mic shows it is listening. A level meter, or a ring scaled by input level, moves when sound is heard, so a muted or wrong mic is obvious.
- While dictating, the box is read-only, so the caret stays where the text will go. The send action is disabled until the text is inserted.
- **Errors** (permission denied, no device, no key, provider error) show in the mic tooltip or a toast, and the box stays usable.

## Server

- `packages/services/src/dictation.ts` holds `createDictationService({ modelKeys, fetch })` with these methods:
  - `status(principal)`, which returns `{ available }`;
  - `transcribe(principal, { audio, final })`, where `audio` is base64 WAV of at most 15 s plus a margin;
  - `polish(principal, { text })`.

  Each method authorizes the principal, reads the workspace's OpenRouter key through `model-keys`, and never logs audio, text or the key.
- The tRPC router is `dictation` with `status`, `transcribe` and `polish`, all `workspaceProcedure`. It applies a per-user rate limit with the existing limiter: 90 transcribe calls and 20 polish calls a minute.
- `transcribe` refuses audio that isn't WAV or is too long. Provider errors become a short `ServiceError` with no provider body.

## Component

`apps/web/src/components/dictation/` is a portable module, and its `index.ts` is its only public API:

- `useDictation({ getValue, setValue, inputRef })`, the state machine (idle, starting, listening, finishing, polishing, error);
- `DictationButton`, the mic, the chevron picker and the level indicator;
- `DictationPreview`, an overlay that mirrors the textarea's font, padding, wrapping and scroll. It draws the current value transparently and the preview as visible muted italic text at the caret.

The module takes its server calls as props or through a small adapter, so it doesn't import app routers directly. Wiring it into a box is a few lines. For assistant-ui `ComposerPrimitive.Input`, the adapter uses the composer runtime's text get and set.

## Boxes

- DT.1: `thread/composer-container.tsx` (the main chat) and `desk/new-task-dialog.tsx`.
- DT.2:
  - `live-artifacts/agent-thread.tsx` (`AgentComposer`, artifact and deck chat);
  - `thread/user-edit-composer-container.tsx`;
  - `routines/create-routine-dialog.tsx`;
  - `agent/agent-form.tsx` (instructions);
  - `agent/builder/describe-panel.tsx` and `agent/builder/draft-card.tsx`;
  - `agent/profile/voice-field.tsx`;
  - `qa/ask-dialog.tsx` and `qa/answer-form.tsx`;
  - `inbox/post-composer.tsx`;
  - `computer/desktop-screen.tsx` (the handback note).
- Not included: guest boxes, comment boxes, and editors that aren't prompts.

## Out of scope

Guests, a platform key, server-side audio storage, voice commands, and a per-workspace model setting.
