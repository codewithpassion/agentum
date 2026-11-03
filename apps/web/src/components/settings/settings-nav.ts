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
    items: [
      { label: "Model providers", to: "/settings/model-providers" },
      { label: "Machines", to: "/settings/machines" },
    ],
    label: "Agents run on",
  },
  {
    items: [
      { label: "Connectors", to: "/settings/connectors" },
      { label: "Secrets", to: "/settings/secrets" },
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
];
