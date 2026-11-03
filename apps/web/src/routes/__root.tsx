import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TooltipProvider } from "#/components/ui/tooltip";
import { useIsAppShell } from "#/hooks/use-app-shell";
import { useIsFullBleed } from "#/hooks/use-full-bleed";
import { cn } from "#/lib/utils";
import Footer from "../components/footer";
import Header from "../components/header";
import ThemedToaster from "../components/themed-toaster";
// Reference the standalone guest asset from the client build as well as the
// Worker build, so its URL is emitted into the public assets directory.
import guestEntry from "../guest-entry.tsx?worker&url";

import ClerkProvider from "../integrations/clerk/provider";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Agentum",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const inAppShell = useIsAppShell();
  const fullBleed = useIsFullBleed();

  return (
    <html
      className="light"
      data-guest-client={guestEntry}
      lang="en"
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme-init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="flex min-h-dvh flex-col font-sans antialiased [overflow-wrap:anywhere] selection:bg-primary/30">
        <ClerkProvider>
          <TooltipProvider>
            {fullBleed ? null : <Header />}
            {/* flex-1 pushes the footer to the bottom on short pages. The app
                shell carries its own footer inside the sidebar inset. */}
            <div
              className={cn("flex-1", !(inAppShell || fullBleed) && "pb-20")}
            >
              {children}
            </div>
            {fullBleed ? null : <Footer />}
            <ThemedToaster />
            <TanStackDevtools
              config={{
                position: "bottom-right",
              }}
              plugins={[
                {
                  name: "Tanstack Router",
                  render: <TanStackRouterDevtoolsPanel />,
                },
              ]}
            />
          </TooltipProvider>
        </ClerkProvider>
        <Scripts />
      </body>
    </html>
  );
}
