import { ClerkProvider } from "@clerk/tanstack-react-start";
import { useResolvedTheme } from "#/hooks/use-resolved-theme";

// Brand tokens from styles.css (`:root` for light, `.dark` for dark), restated
// here because Clerk renders its UI in a shadow root that the app stylesheet's
// CSS variables never reach. Clerk only reads the current variable names
// (colorForeground, colorInput, ...). A name it does not know is ignored, and
// that part then falls back to Clerk's own default instead of the app's theme.
// colorNeutral drives borders and hover fills, so it takes a dark shade on
// light and a light shade on dark.
//
// Clerk paints links with colorPrimary, and terracotta text on the light
// footer is only 2.7:1. The light theme darkens those links (5.1:1 there). In dark
// mode terracotta already passes, and colorModalBackdrop is set because it
// would otherwise follow colorNeutral and turn the backdrop near-white.
const shared = {
  borderRadius: "0.75rem",
  colorPrimary: "#d97757",
  colorPrimaryForeground: "#181818",
  fontFamily: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
};

const light = {
  ...shared,
  colorBackground: "#faf9f5",
  colorDanger: "#b8382e",
  colorForeground: "#181818",
  colorInput: "#ffffff",
  colorInputForeground: "#181818",
  colorMuted: "#efede6",
  colorMutedForeground: "#6b6862",
  colorNeutral: "#181818",
};

const lightLink = { color: "#a34728" };
const lightElements = {
  footerActionLink: lightLink,
  formFieldAction: lightLink,
  formResendCodeLink: lightLink,
  identityPreviewEditButton: lightLink,
};

const dark = {
  ...shared,
  colorBackground: "#222120",
  colorDanger: "#e5695a",
  colorForeground: "#faf9f5",
  colorInput: "#2c2b29",
  colorInputForeground: "#faf9f5",
  colorModalBackdrop: "rgba(0, 0, 0, 0.73)",
  colorMuted: "#2c2b29",
  colorMutedForeground: "#a19d96",
  colorNeutral: "#faf9f5",
};

export default function AppClerkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const theme = useResolvedTheme();

  return (
    <ClerkProvider
      appearance={
        theme === "dark"
          ? { variables: dark }
          : { elements: lightElements, variables: light }
      }
    >
      {children}
    </ClerkProvider>
  );
}
