import { type FormEvent, useCallback, useState } from "react";
import { SectionLabel } from "./df-parts";

const SUBSCRIBE_URL =
  "https://newsletters.rockyshoreslabs.io/api/public/newsletters/agentum/subscribe";

const HTTP_UNPROCESSABLE = 422;
const HTTP_RATE_LIMITED = 429;

type Status = "error" | "idle" | "sent" | "sending";

interface Feedback {
  status: Status;
  text: string;
}

const IDLE: Feedback = { status: "idle", text: "" };

const MESSAGES = {
  generic: "Something went wrong, please try again.",
  invalidEmail: "Please enter a valid email address.",
  rateLimited: "Too many attempts, try again in a few minutes.",
  sent: "Check your inbox to confirm your subscription.",
} as const;

function messageForStatus(code: number): string {
  if (code === HTTP_UNPROCESSABLE) {
    return MESSAGES.invalidEmail;
  }
  if (code === HTTP_RATE_LIMITED) {
    return MESSAGES.rateLimited;
  }
  return MESSAGES.generic;
}

/**
 * Newsletter sign-up. Posts straight to the public subscribe endpoint (CORS is
 * open), and works as a plain HTML form post when JavaScript is off.
 */
export function NewsletterSignup() {
  const [feedback, setFeedback] = useState<Feedback>(IDLE);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (feedback.status === "sending") {
        return;
      }
      const data = new FormData(event.currentTarget);
      setFeedback({ status: "sending", text: "" });
      try {
        const response = await fetch(SUBSCRIBE_URL, {
          body: JSON.stringify({
            email: String(data.get("email") ?? ""),
            name: String(data.get("name") ?? ""),
            website: String(data.get("website") ?? ""),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        setFeedback(
          response.ok
            ? { status: "sent", text: MESSAGES.sent }
            : { status: "error", text: messageForStatus(response.status) }
        );
      } catch {
        setFeedback({ status: "error", text: MESSAGES.generic });
      }
    },
    [feedback.status]
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
                <form
                  action={SUBSCRIBE_URL}
                  className="df-news-form"
                  method="post"
                  onSubmit={onSubmit}
                >
                  <div className="df-news-field">
                    <label className="df-news-label" htmlFor="df-news-email">
                      Email
                    </label>
                    <input
                      autoComplete="email"
                      className="df-input"
                      id="df-news-email"
                      name="email"
                      placeholder="you@company.com"
                      required
                      type="email"
                    />
                  </div>
                  <div className="df-news-field">
                    <label className="df-news-label" htmlFor="df-news-name">
                      Name (optional)
                    </label>
                    <input
                      autoComplete="name"
                      className="df-input"
                      id="df-news-name"
                      name="name"
                      type="text"
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
                  <button
                    className="df-cta df-cta-orange"
                    disabled={sending}
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
