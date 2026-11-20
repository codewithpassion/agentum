export interface SettingsNavItem {
  label: string;
  to: string;
}

export interface SettingsNavGroup {
  items: readonly SettingsNavItem[];
  label: string;
}

export const settingsNav: readonly SettingsNavGroup[] = [
  {
    items: [{ label: "Your sign-ins", to: "/settings/sign-ins" }],
    label: "You",
  },
  {
    items: [
      { label: "Model providers", to: "/settings/model-providers" },
      { label: "Machines", to: "/settings/machines" },
    ],
    label: "Agents run on",
  },
  {
    items: [
      { label: "Apps", to: "/settings/connectors" },
      { label: "Passwords and keys", to: "/settings/secrets" },
      { label: "Artifacts", to: "/settings/artifacts" },
    ],
    label: "Agents can use",
  },
  {
    items: [
      { label: "API keys", to: "/settings/api-keys" },
      { label: "Connected apps", to: "/settings/connected-apps" },
      { label: "Agent connections", to: "/settings/agent-connections" },
    ],
    label: "Access to Agentum",
  },
  {
    items: [{ label: "Timezone", to: "/settings/timezone" }],
    label: "Jobs",
  },
  {
    items: [{ label: "Spend limit", to: "/settings/spend" }],
    label: "Spend",
  },
];
