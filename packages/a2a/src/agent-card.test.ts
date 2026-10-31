import { describe, expect, test } from "bun:test";
import {
  type AgentSkill,
  agentCardSchema,
  buildAgentCard,
} from "./agent-card.ts";
import { HOPS_EXTENSION_URI, PAIRING_EXTENSION_URI } from "./extensions.ts";

const skills: AgentSkill[] = [
  {
    description: "Answers support questions",
    id: "answer",
    name: "Answer",
    tags: ["support"],
  },
];

const card = buildAgentCard({
  agentName: "Support",
  baseUrl: "https://hm.example.com//",
  description: "Answers support questions",
  publicId: "abc123",
  skills,
});

describe("buildAgentCard", () => {
  test("the result parses with agentCardSchema", () => {
    expect(agentCardSchema.safeParse(card).success).toBe(true);
  });

  test("both interface URLs sit under the base, with trailing slashes stripped", () => {
    expect(card.supportedInterfaces).toEqual([
      {
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        url: "https://hm.example.com/a2a/abc123/rpc",
      },
      {
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        url: "https://hm.example.com/a2a/abc123/rest",
      },
    ]);
  });

  test("capabilities set the flags and mark both extensions optional", () => {
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.capabilities.extendedAgentCard).toBe(false);
    expect(card.capabilities.extensions).toEqual([
      {
        description: "Invite based pairing of two Harbourmaster deployments.",
        required: false,
        uri: PAIRING_EXTENSION_URI,
      },
      {
        description:
          "A hop count in message metadata, so a chain of agents cannot loop.",
        required: false,
        uri: HOPS_EXTENSION_URI,
      },
    ]);
  });

  test("the bearer scheme is declared and required", () => {
    expect(card.securitySchemes).toEqual({
      bearer: {
        httpAuthSecurityScheme: {
          description:
            "An access key for this agent, sent as Authorization: Bearer <key>.",
          scheme: "Bearer",
        },
      },
    });
    expect(card.securityRequirements).toEqual([
      { schemes: { bearer: { list: [] } } },
    ]);
  });

  test("the output is stable under a JSON round trip", () => {
    expect(JSON.parse(JSON.stringify(card))).toEqual(card);
  });
});
