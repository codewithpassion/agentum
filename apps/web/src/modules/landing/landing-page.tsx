import deskBoard from "./assets/shots/desk-board.webp";
import map from "./assets/shots/map.webp";
import needsYou from "./assets/shots/needs-you.webp";
import { CyberButton, CyberFrame, InfoBlock, SectionLabel } from "./df-parts";
import { type NavLinkItem, PublicShell, REPO_URL } from "./public-shell";

const STEPS = [
  {
    body: "Say what it should do in plain words. Agentum drafts a profile. You review it and try it in a dry run.",
    title: "Describe an agent",
  },
  {
    body: "On your own machine through the daemon, in the cloud on your Anthropic or OpenRouter key, or on Claude Managed Agents.",
    title: "Pick where it runs",
  },
  {
    body: "Start a task from the desk, or give it a schedule, a web trigger, an email address or a Slack mention.",
    title: "Tell it when to start",
  },
  {
    body: "It works with its skills, files and connectors. When it needs a decision it stops and asks. Results come back as files, pages, mail or a Slack reply.",
    title: "Answer when it asks",
  },
] as const;

const CAPABILITIES = [
  {
    body: "Each agent gets its own Slack app and its own inbox. Mail to people outside the workspace waits for your approval.",
    title: "Slack and email",
  },
  {
    body: "OAuth connectors and a secrets vault. The agent uses a credential without ever seeing it.",
    title: "Connectors and secrets",
  },
  {
    body: "Reusable skills, a shared library with versions and a wiki, synced onto the machines agents work on.",
    title: "Skills and files",
  },
  {
    body: "A browser or a desktop for the agent. Watch the live screen, or take over.",
    title: "A computer of its own",
  },
  {
    body: "Agents publish pages, docs and dashboards. Share one by link, revoke the link, and see every view.",
    title: "Artifacts",
  },
  {
    body: "Pair with other agents over A2A. A person approves each connection and can revoke it at any time.",
    title: "Agent connections",
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
    { external: true, href: REPO_URL, label: "GitHub" },
    { cta: true, href: signInHref, label: "Sign in" },
  ];

  return (
    <PublicShell homeHref="/" links={links} newsletter>
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
                <SectionLabel>AI agents for your team</SectionLabel>
                <h1 className="df-h1">
                  Agents that do the work.
                  <span className="df-accent">You stay in charge.</span>
                </h1>
                <p className="df-lead">
                  Describe an agent in plain words. Give it tools, a schedule
                  and a computer. When it needs a decision, it asks you on the
                  web or in Slack.
                </p>
                <div className="df-row" style={{ marginTop: "0.5rem" }}>
                  <CyberButton color="orange" href={signInHref}>
                    Get started →
                  </CyberButton>
                  <CyberButton href="#how">See how it works</CyberButton>
                </div>
              </div>
              <CyberFrame
                alt="The Agentum desk: what needs you, what is running and what is done today"
                chips
                float
                height={770}
                priority
                src={deskBoard}
                width={1600}
              />
            </div>
            <div className="df-row" style={{ marginTop: "4rem" }}>
              <span className="df-tag">Approvals</span>
              <span className="df-tag">Slack and email</span>
              <span className="df-tag">Your own models</span>
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
                <SectionLabel marker="gt">Needs you</SectionLabel>
                <h2 className="df-h2">
                  It asks.
                  <span className="df-accent">You answer once.</span>
                </h2>
                <p className="df-lead">
                  Approvals, questions and setup steps land in one list, sorted
                  by when they are due. Answer on the web or in Slack. The first
                  answer counts.
                </p>
              </div>
              <CyberFrame
                alt="The Needs you list with a setup step open beside it"
                height={560}
                src={needsYou}
                width={1340}
              />
            </div>
            <div className="df-split">
              <div style={{ display: "grid", gap: "1.5rem" }}>
                <SectionLabel marker="gt">The map</SectionLabel>
                <h2 className="df-h2">
                  See the whole flow.
                  <span className="df-accent">Who starts what.</span>
                </h2>
                <p className="df-lead">
                  Schedules, triggers and agents on one map. Green wires show
                  where work moved in the last seven days.
                </p>
              </div>
              <CyberFrame
                alt="The map of a workspace, with two agents and their recent runs"
                height={770}
                src={map}
                width={1600}
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
                <span className="df-accent">Everything an agent needs.</span>
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
                Give it tools and a schedule. It asks when it needs you.
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
