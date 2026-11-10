# CL.4: one signed-token helper

Round 1 (4b1254f2): review clean, no must-fix.

Done: `signClaims`, `openClaims`, `hmacKeyFromText` and `sha256Hex` in `packages/services/src/crypto.ts`. Run and session tokens, the view token, the room ticket and the room admission assertion use them. Run and session tokens pass `signPrefix: true`, because their MAC covers the prefix. The other three sign the payload alone. `signed-claims-legacy.test.ts` and a test in `room-admission.test.ts` rebuild the old formats and check that old tokens verify and new ones are the same bytes.

Nits left:
- The room ticket and admission same-bytes tests take the prefix from the new signer's output.
- No old-format test for session tokens (`ag_ses_`). They share the run token path.
- The `signClaims` doc comment says the payload is parsed only after the MAC matches. It is decoded first, parsed after.

Beyond the scope: `sha256Hex` is a rename, and `hashToken` stays as an alias. Local hex-digest copies remain in `apps/web/src/server/mcp/clerk-oauth.ts`, `routes/artifacts.ts` and `artifact-content/routes.ts`. `skills-store/tree.ts` has a different `sha256Hex(bytes)`. Switching them is a separate task.

Not verified: staging checks (controller's). Live tokens were checked only through rebuilt old formats, not against a deployed token.

Steps for Dom: none.
