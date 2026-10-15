import { ClerkProvider } from "@clerk/tanstack-react-start";

// Light brand tokens from styles.css, restated here because Clerk renders its
// UI in a shadow root that the app stylesheet's CSS variables never reach.
const appearance = {
  variables: {
    borderRadius: "0.75rem",
    colorBackground: "#faf9f5",
    colorDanger: "#b8382e",
    colorInputBackground: "#ffffff",
    colorInputText: "#181818",
    colorPrimary: "#d97757",
    colorText: "#181818",
    colorTextSecondary: "#6b6862",
    fontFamily: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
  },
};

export default function AppClerkProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ClerkProvider appearance={appearance}>{children}</ClerkProvider>;
}
