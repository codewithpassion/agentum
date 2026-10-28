# LR.1 Guest session survives an interrupted committed rotation

## Design note

Problem. Every guest HTTP request rotates the HttpOnly session token. The database keeps only the replacement hash. If navigation or termination stops the response reaching the browser, the browser keeps a token the server no longer accepts and the guest loses the session. See `LG.RELOAD.md`.

Scheme. Each session row keeps the token it replaced (`previous_token_hash`) and a deadline (`previous_valid_until`, 120 seconds after the rotation). Rotation accepts the current token, or the previous token until its deadline. In both cases the replaced current token becomes the new previous token. So a session always accepts the latest token and the one before it, never an older one.

- Lost response. The browser still holds the old token, which is now the previous one. Its next request rotates again and the cookie is replaced.
- Worker restart. The state is in D1 only, so a fresh isolate recovers the same way.
- Two tabs at once. Both requests succeed. The cookie jar ends with either replacement, and each one is the current or the previous token, so both recover.
- Old token replay. A token is spent when it is current and once more when it is previous. Any later rotation drops it. After the deadline it is dead. The audit view row is written only by a rotation from the current token, so a recovery never double counts an open.

What does not change. Only rotation (`open`, `renew`) and sign-out accept the previous token. `findGuestSessionGrant`, the access reader, the socket upgrade, run authentication, embeds and every write guard still require the current token. The recovery runs the same grant joins as a normal rotation (live member, matching role and grant expiry, artifact kind, workspace switch, session expiry), repeated inside the atomic write. Revocation, expiry, role change, the guest switch and sign-out therefore win over recovery, and the five-second revocation deadline is untouched. The routes rotate before they read, so a request that arrives with the previous token authenticates through the rotation and then continues with the replacement token.

Trade-off. A stolen previous token is usable once more for up to 120 seconds, the same exposure as a stolen current token for that long. Rotation then invalidates the thief's or the owner's copy, and the loser re-enters through the next rotation of the other copy, as with any stolen current token.

Schema. Migration `0033` adds two nullable columns and an index on `guest_sessions`. If LR.2 or LR.3 also add a migration, the later merge renumbers.
