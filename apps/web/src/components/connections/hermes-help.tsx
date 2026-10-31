import {
  HERMES_APPROVAL_NOTE,
  hermesCallEnvironment,
  hermesConfigYaml,
} from "#/components/connections/connections-logic";
import { CopyBlock } from "#/components/connections/copy-block";

/** How to paste a key into a Hermes agent's config. */
export function HermesKeyHelp({
  agentName,
  cardUrl,
  token,
}: {
  agentName: string;
  cardUrl: string;
  token: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Using Hermes?</h3>
      <CopyBlock
        label="Paste into ~/.hermes/config.yaml"
        text={hermesConfigYaml({ cardUrl, name: agentName, token })}
      />
      <p className="text-muted-foreground text-sm">{HERMES_APPROVAL_NOTE}</p>
    </div>
  );
}

/** The settings a Hermes operator sets so this workspace may call their agent. */
export function HermesCallHelp() {
  const settings = hermesCallEnvironment({
    publicUrl: "https://<your Hermes address>",
    tokenName: "harbourmaster",
  });

  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Calling a Hermes agent?</h3>
      <ul className="flex flex-col gap-2 text-sm">
        {settings.map((setting) => (
          <li className="flex flex-col gap-0.5" key={setting.name}>
            <span>
              <code className="font-mono text-xs">{setting.name}</code>
              {" Example: "}
              <code className="font-mono text-xs">{setting.value}</code>
            </span>
            <span className="text-muted-foreground">{setting.note}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        The credential you give below is the token Hermes was given under that
        name.
      </p>
    </div>
  );
}
