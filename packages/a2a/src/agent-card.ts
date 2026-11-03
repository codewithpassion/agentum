import { z } from "zod";
import { HOPS_EXTENSION_URI, PAIRING_EXTENSION_URI } from "./extensions.ts";
import { structSchema } from "./messages.ts";
import { A2A_PROTOCOL_VERSION } from "./protocol.ts";
import { securityRequirementSchema, securitySchemeSchema } from "./security.ts";

export const agentInterfaceSchema = z.object({
  protocolBinding: z.string().min(1),
  protocolVersion: z.string().min(1),
  tenant: z.string().optional(),
  url: z.string().min(1),
});
export type AgentInterface = z.infer<typeof agentInterfaceSchema>;

export const agentProviderSchema = z.object({
  organization: z.string().min(1),
  url: z.string().min(1),
});
export type AgentProvider = z.infer<typeof agentProviderSchema>;

export const agentExtensionSchema = z.object({
  description: z.string().optional(),
  params: structSchema.optional(),
  required: z.boolean().optional(),
  uri: z.string(),
});
export type AgentExtension = z.infer<typeof agentExtensionSchema>;

export const agentCapabilitiesSchema = z.object({
  extendedAgentCard: z.boolean().optional(),
  extensions: z.array(agentExtensionSchema).optional(),
  pushNotifications: z.boolean().optional(),
  streaming: z.boolean().optional(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentSkillSchema = z.object({
  description: z.string(),
  examples: z.array(z.string()).optional(),
  id: z.string().min(1),
  inputModes: z.array(z.string()).optional(),
  name: z.string().min(1),
  outputModes: z.array(z.string()).optional(),
  securityRequirements: z.array(securityRequirementSchema).optional(),
  tags: z.array(z.string()).min(1),
});
export type AgentSkill = z.infer<typeof agentSkillSchema>;

/** A JWS over the card. Parsed so a signed card is accepted, never verified here. */
export const agentCardSignatureSchema = z.object({
  header: structSchema.optional(),
  protected: z.string().min(1),
  signature: z.string().min(1),
});

/**
 * Arrays the proto marks required must hold at least one element (spec
 * section 5.7). Unknown fields, such as Hermes's `url`, `security` and
 * `stateTransitionHistory`, are ignored. A 0.3 card with no
 * `supportedInterfaces` fails here.
 */
export const agentCardSchema = z.object({
  capabilities: agentCapabilitiesSchema,
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  description: z.string(),
  documentationUrl: z.string().optional(),
  iconUrl: z.string().optional(),
  name: z.string().min(1),
  provider: agentProviderSchema.optional(),
  securityRequirements: z.array(securityRequirementSchema).optional(),
  securitySchemes: z.record(z.string(), securitySchemeSchema).optional(),
  signatures: z.array(agentCardSignatureSchema).optional(),
  skills: z.array(agentSkillSchema).min(1),
  supportedInterfaces: z.array(agentInterfaceSchema).min(1),
  version: z.string().min(1),
});
export type AgentCard = z.infer<typeof agentCardSchema>;

export interface AgentCardInput {
  agentName: string;
  baseUrl: string;
  description: string;
  publicId: string;
  skills: AgentSkill[];
}

const TRAILING_SLASHES = /\/+$/;

/** Builds the card a published agent serves. Pure: no reads, no clock. */
export const buildAgentCard = ({
  agentName,
  baseUrl,
  description,
  publicId,
  skills,
}: AgentCardInput): AgentCard => {
  const origin = baseUrl.replace(TRAILING_SLASHES, "");
  const base = `${origin}/a2a/${publicId}`;
  return {
    capabilities: {
      extendedAgentCard: false,
      extensions: [
        {
          description: "Invite based pairing of two Agentum deployments.",
          required: false,
          uri: PAIRING_EXTENSION_URI,
        },
        {
          description:
            "A hop count in message metadata, so a chain of agents cannot loop.",
          required: false,
          uri: HOPS_EXTENSION_URI,
        },
      ],
      pushNotifications: true,
      streaming: true,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    description,
    name: agentName,
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          description:
            "An access key for this agent, sent as Authorization: Bearer <key>.",
          scheme: "Bearer",
        },
      },
    },
    skills,
    supportedInterfaces: [
      {
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        url: `${base}/rpc`,
      },
      {
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
        url: `${base}/rest`,
      },
    ],
    version: "1.0.0",
  };
};
