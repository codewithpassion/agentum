/** biome-ignore-all lint/performance/noJsxPropsBind: Form callbacks capture local state. */
import type {
  GuestLandingResult,
  GuestVerifyResult,
} from "@repo/protocol/guest";
import { guestEndpoints } from "@repo/protocol/guest";
import { useEffect, useState } from "react";
import { guestHttp } from "./http";

export function GuestLanding({ token }: { token: string }) {
  const [landing, setLanding] = useState<GuestLandingResult>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    guestHttp
      .json<GuestLandingResult>(guestEndpoints.invitation(token))
      .then(setLanding)
      .catch(() => setError("This invite is not available."));
  }, [token]);
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await guestHttp.json(guestEndpoints.code(token), {});
      setSent(true);
    } catch {
      setError("Could not request a code. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await guestHttp.json<GuestVerifyResult>(
        guestEndpoints.verify(token),
        { code }
      );
      // Do not follow an arbitrary server-provided redirect.
      window.location.assign(
        `/g/a/${encodeURIComponent(result.grant.artifactId)}`
      );
    } catch {
      setError(
        "This invite is not available. Check your code or request a new one."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="guest-landing">
      <p>Harbourmaster · Shared with you</p>
      {landing ? (
        <>
          <h1>{landing.artifactTitle}</h1>
          <p>
            {landing.inviterName} from {landing.workspaceName} invited you as{" "}
            {landing.role}.
          </p>
          {landing.expiresAt !== null && (
            <p>Access ends {new Date(landing.expiresAt).toLocaleString()}.</p>
          )}
          <button disabled={busy} onClick={send} type="button">
            {sent ? "Send a new code" : "Send me a code"}
          </button>
          {sent === true && (
            <form onSubmit={verify}>
              <p>
                If this invite is available, a code was sent to the invited
                address. It expires in 10 minutes.
              </p>
              <label>
                6-digit code
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ""))
                  }
                  pattern="[0-9]{6}"
                  required
                  value={code}
                />
              </label>
              <button disabled={busy || code.length !== 6} type="submit">
                Verify code
              </button>
            </form>
          )}
        </>
      ) : (
        !error && <p role="status">Loading invitation…</p>
      )}
      {Boolean(error) && <p role="alert">{error}</p>}
    </main>
  );
}
