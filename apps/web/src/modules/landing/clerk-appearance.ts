import type { SignIn } from "@clerk/tanstack-react-start";
import type { ComponentProps } from "react";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

/** Delta Foxtrot skin for Clerk's prebuilt components: sharp corners, orange primary. */
export const clerkAppearance: ClerkAppearance = {
  elements: {
    card: { background: "transparent", border: "none", boxShadow: "none" },
    footer: { background: "transparent" },
    formButtonPrimary: {
      borderRadius: 0,
      fontFamily: '"Orbitron", monospace',
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    },
    header: { display: "none" },
    headerTitle: {
      fontFamily: '"Orbitron", monospace',
      fontWeight: 900,
      textTransform: "uppercase",
    },
  },
  variables: {
    borderRadius: "0",
    colorBackground: "#1a1a1a",
    colorForeground: "#fafafa",
    colorInput: "#2a2a2a",
    colorInputForeground: "#fafafa",
    colorMutedForeground: "#a5a5a5",
    colorNeutral: "#ffffff",
    colorPrimary: "#ff7733",
    colorPrimaryForeground: "#000000",
    fontFamily: '"Roboto", sans-serif',
  },
};
