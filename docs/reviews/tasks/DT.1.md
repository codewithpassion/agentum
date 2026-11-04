# DT.1 review

Executor: Codex (gpt-6.1-sol). Reviewer: an Opus agent, then the controller.

- First pass: 3 major findings (no resampling when the browser ignores 16 kHz; one failed request discarded the whole dictation; the preview was cut off past the box height) and 6 minor (placeholder under the preview, mirror width and fonts, saved mic ignored before permission, per-sample voice detection, borrowed limiters, double tooltip).
- Fix round 46847883 fixed all but the limiters. The controller checked the resampler (weighted average, any input rate), that a failed final keeps its interim text, and RMS frames with silent segments dropped.
- Verified correct: click and hold timing, Ctrl+D with auto-repeat ignored, Escape in the capture phase, read-only and send blocked, insert at caret, raw fallback, mic cleanup on every path, WAV header, members only, the key stays server side, no logging, provider errors carry no body, module boundary, assistant-ui ref and setText.
- Open: the dictation limits reuse the `SHARE_OPEN_LIMIT` and `APP_API_LIMIT` bindings under their own keys. A dedicated binding needs a wrangler change. Live transcription in a browser waits for staging.
- Verdict: accept.
