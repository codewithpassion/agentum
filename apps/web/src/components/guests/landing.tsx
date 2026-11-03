/** biome-ignore-all lint/performance/noJsxPropsBind: Form callbacks capture local state. */
import type {
  GuestLandingResult,
  GuestVerifyResult,
} from "@repo/protocol/guest";
import { guestEndpoints } from "@repo/protocol/guest";
import { useEffect, useRef, useState } from "react";
import { guestHttp } from "./http";

export function GuestLanding({ token }: { token: string }) {
  return <Invitation key={token} token={token} />;
}

function Invitation({ token }: { token: string }) {
  const active = useRef<boolean>(false);
  const [landing, setLanding] = useState<GuestLandingResult>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const path = window.location.pathname;
    active.current = true;
    guestHttp
      .json<GuestLandingResult>(guestEndpoints.invitation(token))
      .then((result) => {
        if (!disposed && window.location.pathname === path) {
          setLanding(result);
        }
      })
      .catch(() => {
        if (!disposed && window.location.pathname === path) {
          setError("This invite is not available.");
        }
      });
    return () => {
      disposed = true;
      active.current = false;
    };
  }, [token]);
  const send = async () => {
    const path = window.location.pathname;
    setBusy(true);
    setError("");
    try {
      await guestHttp.json(guestEndpoints.code(token), {});
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Effect cleanup changes this ref while the request awaits.
      if (active.current && window.location.pathname === path) {
        setSent(true);
      }
    } catch {
      if (active.current && window.location.pathname === path) {
        setError("Could not request a code. Please try again.");
      }
    } finally {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Effect cleanup changes this ref while the request awaits.
      if (active.current && window.location.pathname === path) {
        setBusy(false);
      }
    }
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    const path = window.location.pathname;
    setBusy(true);
    setError("");
    try {
      const result = await guestHttp.json<GuestVerifyResult>(
        guestEndpoints.verify(token),
        { code }
      );
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Navigation may unmount the invitation while verification awaits.
      if (!active.current || window.location.pathname !== path) {
        return;
      }
      // Do not follow an arbitrary server-provided redirect.
      window.location.assign(
        `/g/a/${encodeURIComponent(result.grant.artifactId)}`
      );
    } catch {
      if (active.current && window.location.pathname === path) {
        setError(
          "This invite is not available. Check your code or request a new one."
        );
      }
    } finally {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Effect cleanup changes this ref while the request awaits.
      if (active.current && window.location.pathname === path) {
        setBusy(false);
      }
    }
  };
  return (
    <main className="guest-landing">
      <p>Agentum · Shared with you</p>
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
