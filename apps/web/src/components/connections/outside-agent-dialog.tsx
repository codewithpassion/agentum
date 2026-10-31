import { type ChangeEvent, useCallback, useState } from "react";
import { CopyBlock } from "#/components/connections/copy-block";
import type { AddDialogProps } from "#/components/connections/dialog-props";
import {
  HermesCallHelp,
  HermesKeyHelp,
} from "#/components/connections/hermes-help";
import { PublishGate } from "#/components/connections/publish-gate";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";

type Tab = "key" | "call";
type CardPreview = RouterOutputs["a2a"]["previewCard"];
type CardScheme = CardPreview["scheme"];
type Credential = string | { clientId: string; clientSecret: string };
interface Issued {
  agentName: string;
  cardUrl: string;
  token: string;
}
interface TabProps {
  agents: AddDialogProps["agents"];
  onDone: () => void;
  onMade: () => void;
}

interface CredentialFields {
  clientId: string;
  clientSecret: string;
  secret: string;
}

const SCHEME_WORDS: Record<CardScheme, string> = {
  api_key_header: "An API key sent in a header",
  bearer: "A bearer token",
  none: "No credential needed",
  oauth2_client_credentials: "An OAuth client id and secret",
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const hasCredential = (
  scheme: CardScheme,
  fields: CredentialFields
): boolean => {
  if (scheme === "none") {
    return true;
  }
  if (scheme === "oauth2_client_credentials") {
    return fields.clientId.trim() !== "" && fields.clientSecret.trim() !== "";
  }
  return fields.secret.trim() !== "";
};

const credentialOf = (
  scheme: CardScheme,
  fields: CredentialFields
): Credential | undefined => {
  if (scheme === "none") {
    return;
  }
  if (scheme === "oauth2_client_credentials") {
    return {
      clientId: fields.clientId.trim(),
      clientSecret: fields.clientSecret.trim(),
    };
  }
  return fields.secret.trim();
};

function KeyResult({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="font-medium text-sm">Shown once. Copy it now.</p>
      <CopyBlock label="Key" text={issued.token} />
      <CopyBlock label="Card URL" text={issued.cardUrl} />
      <HermesKeyHelp
        agentName={issued.agentName}
        cardUrl={issued.cardUrl}
        token={issued.token}
      />
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  );
}

function KeyTab({ agents, onDone, onMade }: TabProps) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setAgentId(event.target.value);
    },
    []
  );

  const handleLabelChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setLabel(event.target.value);
    },
    []
  );

  const createKey = useCallback(async () => {
    const agentName = agents.find((agent) => agent.id === agentId)?.name ?? "";
    setPending(true);
    setError(null);
    try {
      const result = await getTrpc().a2a.createAccessKey.mutate({
        agentId,
        label,
      });
      setIssued({
        agentName,
        cardUrl: result.cardUrl,
        token: result.token,
      });
      onMade();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId, agents, label, onMade]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Give an outside client, such as Hermes, a key so it can send messages to
        one of your agents.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="outside-key-agent">Agent</Label>
        <NativeSelect
          disabled={issued !== null}
          id="outside-key-agent"
          onChange={handleAgentChange}
          value={agentId}
        >
          {agents.map((agent) => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              {agent.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {agentId === "" ? null : (
        <PublishGate agentId={agentId}>
          {issued === null ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="outside-key-label">Label</Label>
                <Input
                  id="outside-key-label"
                  maxLength={80}
                  onChange={handleLabelChange}
                  placeholder="Hermes on Sam's box"
                  value={label}
                />
              </div>
              {error !== null && (
                <p className="text-destructive text-sm">{error}</p>
              )}
              <DialogFooter>
                <Button
                  disabled={pending || label.trim() === ""}
                  onClick={createKey}
                >
                  Create key
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <KeyResult issued={issued} onDone={onDone} />
          )}
        </PublishGate>
      )}
    </div>
  );
}

function CardSummary({ card }: { card: CardPreview }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{card.name}</p>
        <p className="text-muted-foreground">{card.host}</p>
        {card.org === null ? null : (
          <p className="text-muted-foreground">Organisation: {card.org}</p>
        )}
      </div>
      <p>{card.description}</p>
      {card.skills.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {card.skills.map((skill) => (
            <li key={skill.name}>
              <span className="font-medium">{skill.name}</span>
              {skill.description === "" ? null : `: ${skill.description}`}
            </li>
          ))}
        </ul>
      )}
      <p className="font-medium">{SCHEME_WORDS[card.scheme]}</p>
    </div>
  );
}

function CredentialInputs({
  clientId,
  clientSecret,
  onClientIdChange,
  onClientSecretChange,
  onSecretChange,
  scheme,
  secret,
}: {
  clientId: string;
  clientSecret: string;
  onClientIdChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClientSecretChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSecretChange: (event: ChangeEvent<HTMLInputElement>) => void;
  scheme: CardScheme;
  secret: string;
}) {
  if (scheme === "none") {
    return null;
  }
  if (scheme === "oauth2_client_credentials") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="outside-call-client-id">Client id</Label>
          <Input
            autoComplete="off"
            id="outside-call-client-id"
            onChange={onClientIdChange}
            value={clientId}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="outside-call-client-secret">Client secret</Label>
          <Input
            autoComplete="off"
            id="outside-call-client-secret"
            onChange={onClientSecretChange}
            type="password"
            value={clientSecret}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="outside-call-secret">
        {scheme === "bearer" ? "Bearer token" : "API key"}
      </Label>
      <Input
        autoComplete="off"
        id="outside-call-secret"
        onChange={onSecretChange}
        type="password"
        value={secret}
      />
    </div>
  );
}

function CallTab({ agents, onDone, onMade }: TabProps) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [cardUrl, setCardUrl] = useState("");
  const [card, setCard] = useState<CardPreview | null>(null);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const forgetCard = useCallback(() => {
    setCard(null);
    setError(null);
    setSecret("");
    setClientId("");
    setClientSecret("");
  }, []);

  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setAgentId(event.target.value);
      forgetCard();
    },
    [forgetCard]
  );

  const handleUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setCardUrl(event.target.value);
      forgetCard();
    },
    [forgetCard]
  );

  const handleLabelChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setLabel(event.target.value);
    },
    []
  );

  const handleSecretChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSecret(event.target.value);
    },
    []
  );

  const handleClientIdChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setClientId(event.target.value);
    },
    []
  );

  const handleClientSecretChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setClientSecret(event.target.value);
    },
    []
  );

  const lookUp = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      setCard(
        await getTrpc().a2a.previewCard.mutate({
          agentId,
          cardUrl: cardUrl.trim(),
        })
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId, cardUrl]);

  const connect = useCallback(async () => {
    if (card === null) {
      return;
    }
    const trimmedLabel = label.trim();
    const credential = credentialOf(card.scheme, {
      clientId,
      clientSecret,
      secret,
    });
    setPending(true);
    setError(null);
    try {
      await getTrpc().a2a.addOutbound.mutate({
        agentId,
        cardUrl: cardUrl.trim(),
        ...(trimmedLabel === "" ? {} : { label: trimmedLabel }),
        ...(credential === undefined ? {} : { credential }),
      });
      setConnected(true);
      onMade();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId, card, cardUrl, clientId, clientSecret, label, onMade, secret]);

  const fields = { clientId, clientSecret, secret };

  return (
    <div className="flex flex-col gap-4">
      {connected ? (
        <div className="flex flex-col gap-4">
          <p className="font-medium text-sm">Connected.</p>
          <DialogFooter>
            <Button onClick={onDone}>Done</Button>
          </DialogFooter>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="outside-call-agent">Agent</Label>
            <NativeSelect
              id="outside-call-agent"
              onChange={handleAgentChange}
              value={agentId}
            >
              {agents.map((agent) => (
                <NativeSelectOption key={agent.id} value={agent.id}>
                  {agent.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="outside-call-url">Agent card URL</Label>
            <Input
              id="outside-call-url"
              onChange={handleUrlChange}
              placeholder="https://"
              type="url"
              value={cardUrl}
            />
          </div>
          <div>
            <Button
              disabled={pending || agentId === "" || cardUrl.trim() === ""}
              onClick={lookUp}
              variant="outline"
            >
              Look it up
            </Button>
          </div>
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          {card === null ? null : (
            <div className="flex flex-col gap-4">
              <CardSummary card={card} />
              <CredentialInputs
                clientId={clientId}
                clientSecret={clientSecret}
                onClientIdChange={handleClientIdChange}
                onClientSecretChange={handleClientSecretChange}
                onSecretChange={handleSecretChange}
                scheme={card.scheme}
                secret={secret}
              />
              {card.scheme === "none" ? null : (
                <p className="text-muted-foreground text-sm">
                  The credential is sent only to {card.host}.
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="outside-call-label">Label (optional)</Label>
                <Input
                  id="outside-call-label"
                  maxLength={80}
                  onChange={handleLabelChange}
                  value={label}
                />
              </div>
              <DialogFooter>
                <Button
                  disabled={pending || !hasCredential(card.scheme, fields)}
                  onClick={connect}
                >
                  Connect
                </Button>
              </DialogFooter>
            </div>
          )}
        </div>
      )}
      <HermesCallHelp />
    </div>
  );
}

/** The "Connect an outside agent" dialog: give an outside client a key, or call an outside agent. */
export function OutsideAgentDialog({
  agents,
  onClose,
  onChanged,
}: AddDialogProps) {
  const [tab, setTab] = useState<Tab>("key");
  const [made, setMade] = useState(false);

  const markMade = useCallback(() => {
    setMade(true);
  }, []);

  const finish = useCallback(() => {
    onChanged();
    onClose();
  }, [onChanged, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (made) {
          onChanged();
        }
        onClose();
      }
    },
    [made, onChanged, onClose]
  );

  const selectTab = useCallback((next: string) => {
    setTab(next === "call" ? "call" : "key");
  }, []);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect an outside agent</DialogTitle>
          <DialogDescription>
            Let an outside client call one of your agents, or let one of your
            agents call an outside agent.
          </DialogDescription>
        </DialogHeader>
        <Tabs onValueChange={selectTab} value={tab}>
          <TabsList>
            <TabsTrigger value="key">Give it a key</TabsTrigger>
            <TabsTrigger value="call">Call it</TabsTrigger>
          </TabsList>
          <TabsContent
            className="pt-4 data-[state=inactive]:hidden"
            forceMount
            value="key"
          >
            <KeyTab agents={agents} onDone={finish} onMade={markMade} />
          </TabsContent>
          <TabsContent
            className="pt-4 data-[state=inactive]:hidden"
            forceMount
            value="call"
          >
            <CallTab agents={agents} onDone={finish} onMade={markMade} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
