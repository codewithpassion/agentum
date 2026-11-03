import { ClerkProvider } from "@clerk/tanstack-react-start";
import { useResolvedTheme } from "#/hooks/use-resolved-theme";
import { PendingSessionGate } from "./pending-session-gate";

// Brand tokens from styles.css (`:root` for light, `.dark` for dark), restated
// here because Clerk renders its UI in a shadow root that the app stylesheet's
// CSS variables never reach. Clerk only reads the current variable names
// (colorForeground, colorInput, ...). A name it does not know is ignored, and
// that part then falls back to Clerk's own default instead of the app's theme.
// colorNeutral drives borders and hover fills, so it takes a dark shade on
// light and a light shade on dark.
//
// Clerk paints links with colorPrimary, and Delta Foxtrot orange text on the
// light footer is only about 2.6:1. The light theme darkens those links (about
// 5:1 there). In dark mode orange already passes, and colorModalBackdrop is set because it
// would otherwise follow colorNeutral and turn the backdrop near-white.

// Every sign-in, sign-up and session-task URL points at the app. Clerk builds
// these URLs from the instance's hosted Account Portal unless they are set,
// including the one a pending organisation task redirects to after OAuth.
const routing = {
  afterSignOutUrl: "/",
  signInFallbackRedirectUrl: "/",
  signInUrl: "/login",
  signUpFallbackRedirectUrl: "/",
  signUpUrl: "/sign-up",
  taskUrls: { "choose-organization": "/choose-organization" },
};

const shared = {
  borderRadius: "0",
  colorPrimary: "#ff7733",
  colorPrimaryForeground: "#1a1a1a",
  fontFamily: '"Roboto", ui-sans-serif, system-ui, sans-serif',
};

const light = {
  ...shared,
  colorBackground: "#f5f5f5",
  colorDanger: "#d4153a",
  colorForeground: "#1a1a1a",
  colorInput: "#ffffff",
  colorInputForeground: "#1a1a1a",
  colorMuted: "#ebebeb",
  colorMutedForeground: "#5c5c5c",
  colorNeutral: "#1a1a1a",
};

const lightLink = { color: "#b04a12" };
const lightElements = {
  footerActionLink: lightLink,
  formFieldAction: lightLink,
  formResendCodeLink: lightLink,
  identityPreviewEditButton: lightLink,
};

const dark = {
  ...shared,
  colorBackground: "#212121",
  colorDanger: "#ff3859",
  colorForeground: "#ffffff",
  colorInput: "#2a2a2a",
  colorInputForeground: "#ffffff",
  colorModalBackdrop: "rgba(0, 0, 0, 0.73)",
  colorMuted: "#2a2a2a",
  colorMutedForeground: "#a5a5a5",
  colorNeutral: "#ffffff",
};

export default function AppClerkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const theme = useResolvedTheme();

  return (
    <ClerkProvider
      {...routing}
      appearance={
        theme === "dark"
          ? { variables: dark }
          : { elements: lightElements, variables: light }
      }
    >
      <PendingSessionGate />
      {children}
    </ClerkProvider>
  );
}
