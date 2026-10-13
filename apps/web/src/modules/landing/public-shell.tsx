import type { ReactNode } from "react";
import "./landing.css";
import { Logo } from "./df-parts";

export interface NavLinkItem {
  cta?: boolean;
  href: string;
  label: string;
  /** Hidden below the md breakpoint, where the bar only has room for the CTA. */
  secondary?: boolean;
}

const cx = (...parts: (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

export const BRAND = "Agentum";

/** Fixed top bar shared by every public page. */
export function PublicNav({
  homeHref,
  links,
}: {
  homeHref: string;
  links: NavLinkItem[];
}) {
  return (
    <nav aria-label="Main" className="df-nav">
      <div className="df-nav-inner">
        <a aria-label={`${BRAND} home`} href={homeHref}>
          <Logo name="AGENTUM" />
        </a>
        <div className="df-nav-links">
          {links.map((link) => (
            <a
              className={cx(
                "df-nav-link",
                link.cta && "df-nav-link-cta",
                link.secondary && "df-nav-hide-mobile"
              )}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}

export function PublicFooter() {
  return (
    <footer className="df-footer">
      <div className="df-footer-inner">
        <span>
          &copy; {new Date().getFullYear()} AGENTUM. All rights reserved.
        </span>
        <span>Built on Claude Managed Agents</span>
      </div>
    </footer>
  );
}

/**
 * Page chrome for the signed-out pages: dark ground, grid, nav and footer.
 * `homeHref` and `links` come from the caller so the module owns no routes.
 */
export function PublicShell({
  children,
  homeHref,
  links,
}: {
  children: ReactNode;
  homeHref: string;
  links: NavLinkItem[];
}) {
  return (
    <div className="df">
      <div aria-hidden="true" className="df-grid" />
      <PublicNav homeHref={homeHref} links={links} />
      {children}
      <PublicFooter />
    </div>
  );
}
