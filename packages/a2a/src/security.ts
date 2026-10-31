import { z } from "zod";
import { exactlyOneOf } from "./oneof.ts";

const scopesSchema = z.record(z.string(), z.string());

export const authorizationCodeOAuthFlowSchema = z.object({
  authorizationUrl: z.string().min(1),
  pkceRequired: z.boolean().optional(),
  refreshUrl: z.string().optional(),
  scopes: scopesSchema,
  tokenUrl: z.string().min(1),
});

export const clientCredentialsOAuthFlowSchema = z.object({
  refreshUrl: z.string().optional(),
  scopes: scopesSchema,
  tokenUrl: z.string().min(1),
});

export const deviceCodeOAuthFlowSchema = z.object({
  deviceAuthorizationUrl: z.string().min(1),
  refreshUrl: z.string().optional(),
  scopes: scopesSchema,
  tokenUrl: z.string().min(1),
});

/** Deprecated in the proto, still accepted when a peer declares it. */
export const implicitOAuthFlowSchema = z.object({
  authorizationUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  scopes: scopesSchema.optional(),
});

/** Deprecated in the proto, still accepted when a peer declares it. */
export const passwordOAuthFlowSchema = z.object({
  refreshUrl: z.string().optional(),
  scopes: scopesSchema.optional(),
  tokenUrl: z.string().optional(),
});

const OAUTH_FLOW_KEYS = [
  "authorizationCode",
  "clientCredentials",
  "implicit",
  "password",
  "deviceCode",
] as const;

export const oAuthFlowsSchema = z
  .object({
    authorizationCode: authorizationCodeOAuthFlowSchema.optional(),
    clientCredentials: clientCredentialsOAuthFlowSchema.optional(),
    deviceCode: deviceCodeOAuthFlowSchema.optional(),
    implicit: implicitOAuthFlowSchema.optional(),
    password: passwordOAuthFlowSchema.optional(),
  })
  .refine(exactlyOneOf(OAUTH_FLOW_KEYS), {
    message: "OAuth flows hold exactly one flow",
  });
export type OAuthFlows = z.infer<typeof oAuthFlowsSchema>;

export const apiKeySecuritySchemeSchema = z.object({
  description: z.string().optional(),
  location: z.string().min(1),
  name: z.string().min(1),
});

export const httpAuthSecuritySchemeSchema = z.object({
  bearerFormat: z.string().optional(),
  description: z.string().optional(),
  scheme: z.string().min(1),
});

export const oAuth2SecuritySchemeSchema = z.object({
  description: z.string().optional(),
  flows: oAuthFlowsSchema,
  oauth2MetadataUrl: z.string().optional(),
});

export const openIdConnectSecuritySchemeSchema = z.object({
  description: z.string().optional(),
  openIdConnectUrl: z.string().min(1),
});

export const mutualTlsSecuritySchemeSchema = z.object({
  description: z.string().optional(),
});

/**
 * Hermes declares `{"type": "http", "scheme": "bearer"}`, the 0.3 shape, where
 * the proto has `{"httpAuthSecurityScheme": {"scheme": "bearer"}}`. Read the
 * first as the second. Only the http type is mapped. Our own cards use the
 * proto's shape.
 */
const readLegacyHttpScheme = (value: unknown): unknown => {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "http" &&
    typeof (value as { scheme?: unknown }).scheme === "string"
  ) {
    const { bearerFormat, description, scheme } = value as {
      bearerFormat?: string;
      description?: string;
      scheme: string;
    };
    return { httpAuthSecurityScheme: { bearerFormat, description, scheme } };
  }
  return value;
};

const SECURITY_SCHEME_KEYS = [
  "apiKeySecurityScheme",
  "httpAuthSecurityScheme",
  "oauth2SecurityScheme",
  "openIdConnectSecurityScheme",
  "mtlsSecurityScheme",
] as const;

/**
 * Named by its member, as the proto's `oneof scheme`. Holds exactly one. The
 * legacy http form is accepted too and comes out as `httpAuthSecurityScheme`.
 */
export const securitySchemeSchema = z.preprocess(
  readLegacyHttpScheme,
  z
    .object({
      apiKeySecurityScheme: apiKeySecuritySchemeSchema.optional(),
      httpAuthSecurityScheme: httpAuthSecuritySchemeSchema.optional(),
      mtlsSecurityScheme: mutualTlsSecuritySchemeSchema.optional(),
      oauth2SecurityScheme: oAuth2SecuritySchemeSchema.optional(),
      openIdConnectSecurityScheme: openIdConnectSecuritySchemeSchema.optional(),
    })
    .refine(exactlyOneOf(SECURITY_SCHEME_KEYS), {
      message: "A security scheme holds exactly one scheme",
    })
);
export type SecurityScheme = z.infer<typeof securitySchemeSchema>;

/** `StringList` in the proto: the scopes one scheme needs. */
const stringListSchema = z.object({ list: z.array(z.string()).optional() });

/** Maps a scheme name from `securitySchemes` to the scopes it needs. */
export const securityRequirementSchema = z.object({
  schemes: z.record(z.string(), stringListSchema).default({}),
});
export type SecurityRequirement = z.infer<typeof securityRequirementSchema>;
