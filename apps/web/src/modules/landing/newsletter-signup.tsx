import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { SectionLabel } from "./df-parts";

const SUBSCRIBE_PATH = "/api/newsletter/subscribe";
// Public keys. Production builds use the real widget (agentumbot.io and
// agentum.rockyshoreslabs.io); dev uses Cloudflare's always-pass test key, which
// the route accepts only on localhost.
const PRODUCTION_SITE_KEY = "0x4AAAAAAGNxncr7sBoBDII8";
const TEST_SITE_KEY = "1x00000000000000000000AA";
const SITE_KEY = import.meta.env.PROD ? PRODUCTION_SITE_KEY : TEST_SITE_KEY;
const GENERIC_ERROR = "Something went wrong, please try again.";

type Status = "error" | "idle" | "sent" | "sending";

interface Feedback {
  status: Status;
  text: string;
}

const IDLE: Feedback = { status: "idle", text: "" };

/** The server's `message` field, or the generic text when the body has none. */
async function readMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "message" in body) {
    const { message } = body;
    if (typeof message === "string" && message !== "") {
      return message;
    }
  }
  return GENERIC_ERROR;
}

/**
 * Newsletter sign-up. Posts JSON to our own route, which checks the Turnstile
 * token and then subscribes the address. The browser never calls the
 * newsletters app.
 */
export function NewsletterSignup() {
  const [feedback, setFeedback] = useState<Feedback>(IDLE);
  const [token, setToken] = useState("");
  const turnstile = useRef<TurnstileInstance>(null);

  const clearToken = useCallback(() => setToken(""), []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (feedback.status === "sending" || token === "") {
        return;
      }
      const data = new FormData(event.currentTarget);
      setFeedback({ status: "sending", text: "" });
      try {
        const response = await fetch(SUBSCRIBE_PATH, {
          body: JSON.stringify({
            email: String(data.get("email") ?? ""),
            turnstileToken: token,
            website: String(data.get("website") ?? ""),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const text = await readMessage(response);
        setFeedback({ status: response.ok ? "sent" : "error", text });
      } catch {
        setFeedback({ status: "error", text: GENERIC_ERROR });
      } finally {
        // The token is spent once the request may have reached the server.
        setToken("");
        turnstile.current?.reset();
      }
    },
    [feedback.status, token]
  );

  const sent = feedback.status === "sent";
  const sending = feedback.status === "sending";

  return (
    <section
      aria-labelledby="df-news-title"
      className="df-section df-news"
      id="newsletter"
    >
      <div className="df-container">
        <div className="df-narrow df-center df-news-body">
          <SectionLabel>Stay in the loop</SectionLabel>
          <h2 className="df-h2" id="df-news-title">
            Get updates
          </h2>
          <p className="df-lead">
            New features and releases, straight to your inbox.
          </p>
          <div aria-live="polite" className="df-news-live">
            {sent ? (
              <p className="df-news-message df-news-sent">{feedback.text}</p>
            ) : (
              <>
                <form className="df-news-form" onSubmit={onSubmit}>
                  <div className="df-news-field">
                    <label className="df-news-label" htmlFor="df-news-email">
                      Email
                    </label>
                    <input
                      autoComplete="email"
                      className="df-input"
                      data-1p-ignore
                      data-lpignore="true"
                      id="df-news-email"
                      name="email"
                      placeholder="you@company.com"
                      required
                      type="email"
                    />
                  </div>
                  <input
                    aria-hidden="true"
                    autoComplete="off"
                    className="df-hp"
                    name="website"
                    tabIndex={-1}
                    type="text"
                  />
                  <Turnstile
                    onError={clearToken}
                    onExpire={clearToken}
                    onSuccess={setToken}
                    options={{ size: "invisible" }}
                    ref={turnstile}
                    siteKey={SITE_KEY}
                  />
                  <button
                    className="df-cta df-cta-orange"
                    disabled={sending || token === ""}
                    type="submit"
                  >
                    {sending ? "Sending…" : "Subscribe →"}
                  </button>
                </form>
                {feedback.status === "error" ? (
                  <p className="df-news-message df-news-error">
                    {feedback.text}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
