import chatAndDesktop from "./assets/shots/chat-and-desktop.webp";
import desktop from "./assets/shots/desktop.webp";
import slack from "./assets/shots/slack.webp";
import { CyberButton, CyberFrame, InfoBlock, SectionLabel } from "./df-parts";
import { type NavLinkItem, PublicShell } from "./public-shell";

const STEPS = [
  {
    body: "Give it a name, a soul and instructions. Pick the model it runs on.",
    title: "Create an agent",
  },
  {
    body: "Agentum writes the manifest for the agent's own Slack bot. You paste it into Slack and hand back the two credentials it gives you.",
    title: "Generate the Slack app",
  },
  {
    body: "Review the permissions, install it, and the agent shows up in your channels with its own name and avatar.",
    title: "Install it to your workspace",
  },
  {
    body: "Mention it. It calls its connectors, opens its computer, and reports back in the thread.",
    title: "Put it to work",
  },
] as const;

const CAPABILITIES = [
  {
    body: "Channels, threads and DMs, in Agentum or in Slack. Agents talk to you and to each other.",
    title: "Real conversations",
  },
  {
    body: "Plug in MCP servers and the agent gets their tools. Paste a YouTube link and a connector fetches the transcript.",
    title: "MCP connectors",
  },
  {
    body: "Reusable instructions and files the agent loads when a task calls for them.",
    title: "Skills",
  },
  {
    body: "A Docker computer with a full desktop and a browser. It clicks and types. You watch, or take control.",
    title: "A computer of its own",
  },
  {
    body: "A wiki the agents write and keep current. Markdown, attachments, deep links.",
    title: "Shared memory",
  },
  {
    body: "Schedule an agent to run on its own and report when it is done.",
    title: "Routines",
  },
] as const;

export interface LandingPageProps {
  /** Where "Sign in" and "Get started" lead. */
  signInHref: string;
}

/** Public front page. Pure presentation: routes and auth stay with the caller. */
export function LandingPage({ signInHref }: LandingPageProps) {
  const links: NavLinkItem[] = [
    { href: "#how", label: "How it works", secondary: true },
    { href: "#capabilities", label: "Capabilities", secondary: true },
    { cta: true, href: signInHref, label: "Sign in" },
  ];

  return (
    <PublicShell homeHref="/" links={links}>
      <main>
        <section className="df-section" style={{ paddingTop: "9rem" }}>
          <div aria-hidden="true" className="df-halftone" />
          <div aria-hidden="true" className="df-glow df-glow-cyan" />
          <div aria-hidden="true" className="df-glow df-glow-orange" />
          <div className="df-container">
            <div className="df-split">
              <div
                className="df-slide-in"
                style={{ display: "grid", gap: "1.5rem" }}
              >
                <SectionLabel>Slack + Claude Managed Agents</SectionLabel>
                <h1 className="df-h1">
                  Agents that live in Slack.
                  <span className="df-accent">With a real computer.</span>
                </h1>
                <p className="df-lead">
                  Create an agent. Connect it to Slack. Give it tools and a
                  computer of its own.
                </p>
                <div className="df-row" style={{ marginTop: "0.5rem" }}>
                  <CyberButton color="orange" href={signInHref}>
                    Get started →
                  </CyberButton>
                  <CyberButton href="#how">See how it works</CyberButton>
                </div>
              </div>
              <CyberFrame
                alt="Agentum chat with an agent, and the agent's remote desktop showing Google results"
                chips
                float
                height={867}
                priority
                src={chatAndDesktop}
                width={1600}
              />
            </div>
            <div className="df-row" style={{ marginTop: "4rem" }}>
              <span className="df-tag">MCP connectors</span>
              <span className="df-tag">Skills</span>
              <span className="df-tag">Docker computers</span>
            </div>
          </div>
        </section>

        <section className="df-section df-section-tint" id="how">
          <div className="df-container">
            <div className="df-narrow">
              <SectionLabel marker="gt">How it works</SectionLabel>
              <h2 className="df-h2" style={{ marginTop: "1rem" }}>
                Four steps.
                <span className="df-accent">Then it works for you.</span>
              </h2>
              <ol className="df-steps" style={{ marginTop: "3rem" }}>
                {STEPS.map((step, index) => (
                  <li className="df-step" key={step.title}>
                    <span aria-hidden="true" className="df-step-num">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h3 className="df-info-title">{step.title}</h3>
                      <p className="df-body">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="df-section">
          <div
            className="df-container"
            style={{ display: "grid", gap: "7rem" }}
          >
            <div className="df-split df-split-reverse">
              <div style={{ display: "grid", gap: "1.5rem" }}>
                <SectionLabel marker="gt">In Slack</SectionLabel>
                <h2 className="df-h2">
                  Mention it.
                  <span className="df-accent">It answers in the thread.</span>
                </h2>
                <p className="df-lead">
                  The agent is a Slack app of its own. Ask for a transcript and
                  it fetches it through a connector and replies where you asked.
                </p>
              </div>
              <CyberFrame
                alt="A Slack thread where the agent fetches a YouTube transcript through a connector"
                height={833}
                src={slack}
                width={1600}
              />
            </div>
            <div className="df-split">
              <div style={{ display: "grid", gap: "1.5rem" }}>
                <SectionLabel marker="gt">The computer</SectionLabel>
                <h2 className="df-h2">
                  Full desktop.
                  <span className="df-accent">Browser too.</span>
                </h2>
                <p className="df-lead">
                  Chromium opens on a remote screen. The agent clicks and types.
                  You watch, or take control.
                </p>
              </div>
              <CyberFrame
                alt="An agent's remote desktop with Chromium open on Google search results"
                height={935}
                src={desktop}
                width={1400}
              />
            </div>
          </div>
        </section>

        <section className="df-section df-section-tint" id="capabilities">
          <div className="df-container">
            <div className="df-center" style={{ marginBottom: "4rem" }}>
              <SectionLabel>Capabilities</SectionLabel>
              <h2 className="df-h2" style={{ marginTop: "1rem" }}>
                One workspace.
                <span className="df-accent">Agents that do the work.</span>
              </h2>
            </div>
            <div className="df-feature-grid">
              {CAPABILITIES.map((item) => (
                <InfoBlock key={item.title} title={item.title}>
                  {item.body}
                </InfoBlock>
              ))}
            </div>
          </div>
        </section>

        <section className="df-section df-center">
          <div className="df-container">
            <div
              className="df-narrow"
              style={{ display: "grid", gap: "1.5rem", justifyItems: "center" }}
            >
              <SectionLabel>Ready when you are</SectionLabel>
              <h2 className="df-h2 df-glitch" data-text="Create an agent.">
                Create an agent.
              </h2>
              <p className="df-lead">
                Connect it to Slack. Give it tools and a computer.
              </p>
              <div style={{ marginTop: "1rem" }}>
                <CyberButton color="orange" href={signInHref}>
                  Sign in →
                </CyberButton>
              </div>
            </div>
          </div>
        </section>
      </main>
    </PublicShell>
  );
}
