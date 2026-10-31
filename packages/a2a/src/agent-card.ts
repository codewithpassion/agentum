import { z } from "zod";
import { structSchema } from "./messages.ts";
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
  uri: z.string().min(1),
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
 * section 5.7). A 0.3 card, with its top-level `url` and `protocolVersion`
 * and no `supportedInterfaces`, fails here.
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
