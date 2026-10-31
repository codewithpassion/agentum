import { describe, expect, test } from "bun:test";
import { agentCardSchema } from "./agent-card.ts";
import {
  HOPS_EXTENSION_URI,
  HOPS_METADATA_KEY,
  PAIRING_EXTENSION_URI,
} from "./extensions.ts";
import sampleCard from "./fixtures/agent-card.json";
import hermesCard from "./fixtures/hermes-agent-card.json";
import hermesMessage from "./fixtures/hermes-message.json";
import sampleTask from "./fixtures/task.json";
import { messageSchema, partSchema } from "./messages.ts";
import {
  authenticationInfoSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  taskPushNotificationConfigSchema,
} from "./requests.ts";
import { securitySchemeSchema } from "./security.ts";
import {
  streamResponseSchema,
  taskArtifactUpdateEventSchema,
  taskSchema,
  taskStatusUpdateEventSchema,
} from "./tasks.ts";

const userMessage = {
  messageId: "msg-uuid",
  parts: [{ text: "What is the weather today?" }],
  role: "ROLE_USER",
};

describe("the spec's sample Agent Card", () => {
  test("parses, keeping its interfaces, schemes and skills", () => {
    const card = agentCardSchema.parse(sampleCard);
    expect(card.supportedInterfaces).toHaveLength(3);
    expect(card.supportedInterfaces[2]?.protocolBinding).toBe("HTTP+JSON");
    expect(card.capabilities.streaming).toBe(true);
    expect(
      card.securitySchemes?.google?.openIdConnectSecurityScheme
        ?.openIdConnectUrl
    ).toContain("accounts.google.com");
    expect(card.securityRequirements?.[0]?.schemes.google?.list).toEqual([
      "openid",
      "profile",
      "email",
    ]);
    expect(card.skills.map((skill) => skill.id)).toEqual([
      "route-optimizer-traffic",
      "custom-map-generator",
    ]);
    expect(card.signatures).toHaveLength(1);
  });

  test("a 0.3 card, with url and protocolVersion on top, is refused", () => {
    const { supportedInterfaces: _dropped, ...rest } = sampleCard;
    const legacy = {
      ...rest,
      protocolVersion: "0.3.0",
      url: "https://georoute-agent.example.com/a2a/v1",
    };
    expect(agentCardSchema.safeParse(legacy).success).toBe(false);
  });

  test("required arrays may not be empty", () => {
    for (const key of [
      "supportedInterfaces",
      "defaultInputModes",
      "defaultOutputModes",
      "skills",
    ]) {
      expect(
        agentCardSchema.safeParse({ ...sampleCard, [key]: [] }).success
      ).toBe(false);
    }
  });

  test("a card needs a name, version and capabilities", () => {
    for (const key of ["name", "version", "capabilities", "description"]) {
      const { [key]: _removed, ...rest } = sampleCard as Record<
        string,
        unknown
      >;
      expect(agentCardSchema.safeParse(rest).success).toBe(false);
    }
  });

  test("a card of the kind we publish parses", () => {
    const ours = {
      capabilities: {
        extendedAgentCard: false,
        extensions: [
          { description: "Pairing", uri: PAIRING_EXTENSION_URI },
          { description: "Hop count", uri: HOPS_EXTENSION_URI },
        ],
        pushNotifications: true,
        streaming: true,
      },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain"],
      description: "Answers support questions",
      name: "Support",
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
      },
      skills: [
        {
          description: "Answers",
          id: "answer",
          name: "Answer",
          tags: ["support"],
        },
      ],
      supportedInterfaces: [
        {
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          url: "https://hm.example.com/a2a/abc/rpc",
        },
        {
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
          url: "https://hm.example.com/a2a/abc/rest",
        },
      ],
      version: "1",
    };
    expect(agentCardSchema.safeParse(ours).success).toBe(true);
  });
});

describe("Task", () => {
  test("the spec's sample task parses", () => {
    const task = taskSchema.parse(sampleTask);
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts?.[0]?.parts[0]?.text).toContain("sunny");
  });

  test("a status carries a message and a UTC timestamp", () => {
    const status = {
      message: { ...userMessage, role: "ROLE_AGENT" },
      state: "TASK_STATE_INPUT_REQUIRED",
      timestamp: "2025-10-28T10:30:00.000Z",
    };
    expect(taskSchema.safeParse({ id: "t", status }).success).toBe(true);
    expect(
      taskSchema.safeParse({
        id: "t",
        status: { ...status, timestamp: "2025-10-28T10:30:00+02:00" },
      }).success
    ).toBe(false);
  });

  test("a 0.3 task, with a lowercase state, is refused", () => {
    expect(
      taskSchema.safeParse({ id: "t", status: { state: "completed" } }).success
    ).toBe(false);
  });

  test("a task needs an id and a status", () => {
    expect(
      taskSchema.safeParse({ status: { state: "TASK_STATE_WORKING" } }).success
    ).toBe(false);
    expect(taskSchema.safeParse({ id: "t" }).success).toBe(false);
  });

  test("a task holding a 0.3 kind part is refused", () => {
    const legacy = {
      ...sampleTask,
      artifacts: [
        { artifactId: "a", parts: [{ kind: "text", text: "Hello, world!" }] },
      ],
    };
    expect(taskSchema.safeParse(legacy).success).toBe(false);
  });
});

describe("Part", () => {
  test("holds exactly one of text, raw, url and data", () => {
    expect(partSchema.safeParse({ text: "hi" }).success).toBe(true);
    expect(
      partSchema.safeParse({ mediaType: "text/plain", raw: "aGk=" }).success
    ).toBe(true);
    expect(
      partSchema.safeParse({
        filename: "a.png",
        url: "https://x.example/a.png",
      }).success
    ).toBe(true);
    expect(partSchema.safeParse({ data: { a: 1 } }).success).toBe(true);
    expect(partSchema.safeParse({ data: null }).success).toBe(true);
    expect(partSchema.safeParse({}).success).toBe(false);
    expect(partSchema.safeParse({ mediaType: "text/plain" }).success).toBe(
      false
    );
    expect(partSchema.safeParse({ data: 1, text: "hi" }).success).toBe(false);
  });

  test("a 0.3 part with a kind is refused", () => {
    expect(
      partSchema.safeParse({ kind: "text", text: "Hello, world!" }).success
    ).toBe(false);
    expect(
      partSchema.safeParse({
        file: { fileWithBytes: "abc", mimeType: "image/png", name: "d.png" },
        kind: "file",
      }).success
    ).toBe(false);
  });
});

describe("Message and SendMessageRequest", () => {
  test("a message needs an id, a role and at least one part", () => {
    expect(messageSchema.safeParse(userMessage).success).toBe(true);
    expect(messageSchema.safeParse({ ...userMessage, parts: [] }).success).toBe(
      false
    );
    expect(
      messageSchema.safeParse({ ...userMessage, role: "user" }).success
    ).toBe(false);
    expect(
      messageSchema.safeParse({ ...userMessage, role: "ROLE_UNSPECIFIED" })
        .success
    ).toBe(false);
    expect(
      messageSchema.safeParse({ ...userMessage, messageId: "" }).success
    ).toBe(false);
  });

  test("the spec's SendMessage body parses", () => {
    const body = sendMessageRequestSchema.parse({ message: userMessage });
    expect(body.message.messageId).toBe("msg-uuid");
  });

  test("the hop count rides in message metadata", () => {
    const request = sendMessageRequestSchema.parse({
      message: { ...userMessage, metadata: { [HOPS_METADATA_KEY]: 2 } },
    });
    expect(request.message.metadata?.[HOPS_METADATA_KEY]).toBe(2);
  });

  test("configuration holds the push config and the blocking flag", () => {
    const parsed = sendMessageRequestSchema.parse({
      configuration: {
        acceptedOutputModes: ["text/plain"],
        historyLength: 0,
        returnImmediately: true,
        taskPushNotificationConfig: {
          authentication: { credentials: "tok", scheme: "Bearer" },
          token: "t",
          url: "https://hm.example.com/a2a/webhooks/t1",
        },
      },
      message: userMessage,
    });
    expect(parsed.configuration?.returnImmediately).toBe(true);
    expect(parsed.configuration?.historyLength).toBe(0);
  });

  test("a negative or fractional history length is refused", () => {
    for (const historyLength of [-1, 1.5]) {
      expect(
        sendMessageRequestSchema.safeParse({
          configuration: { historyLength },
          message: userMessage,
        }).success
      ).toBe(false);
    }
  });

  test("a request without a message is refused", () => {
    expect(sendMessageRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("SendMessageResponse and StreamResponse", () => {
  test("a send response holds a task or a message, not both and not neither", () => {
    expect(
      sendMessageResponseSchema.safeParse({ task: sampleTask }).success
    ).toBe(true);
    expect(
      sendMessageResponseSchema.safeParse({
        message: { ...userMessage, role: "ROLE_AGENT" },
      }).success
    ).toBe(true);
    expect(
      sendMessageResponseSchema.safeParse({
        message: userMessage,
        task: sampleTask,
      }).success
    ).toBe(false);
    expect(sendMessageResponseSchema.safeParse({}).success).toBe(false);
  });

  test("a stream response holds one of its four members", () => {
    const status = { state: "TASK_STATE_WORKING" };
    const events = [
      { task: sampleTask },
      { message: { ...userMessage, role: "ROLE_AGENT" } },
      { statusUpdate: { contextId: "c", status, taskId: "t" } },
      {
        artifactUpdate: {
          artifact: { artifactId: "a", parts: [{ text: "x" }] },
          contextId: "c",
          lastChunk: true,
          taskId: "t",
        },
      },
    ];
    for (const event of events) {
      expect(streamResponseSchema.safeParse(event).success).toBe(true);
    }
    expect(streamResponseSchema.safeParse({}).success).toBe(false);
    expect(
      streamResponseSchema.safeParse({
        statusUpdate: { contextId: "c", status, taskId: "t" },
        task: sampleTask,
      }).success
    ).toBe(false);
  });

  test("the events need both ids", () => {
    const status = { state: "TASK_STATE_WORKING" };
    expect(
      taskStatusUpdateEventSchema.safeParse({ status, taskId: "t" }).success
    ).toBe(false);
    expect(
      taskArtifactUpdateEventSchema.safeParse({
        artifact: { artifactId: "a", parts: [{ text: "x" }] },
        taskId: "t",
      }).success
    ).toBe(false);
  });
});

describe("push notification objects", () => {
  test("a config needs a url, and authentication needs a scheme", () => {
    expect(
      taskPushNotificationConfigSchema.safeParse({ url: "https://x.example/h" })
        .success
    ).toBe(true);
    expect(
      taskPushNotificationConfigSchema.safeParse({ token: "t" }).success
    ).toBe(false);
    expect(
      authenticationInfoSchema.safeParse({ credentials: "x" }).success
    ).toBe(false);
    expect(
      authenticationInfoSchema.safeParse({ scheme: "Bearer" }).success
    ).toBe(true);
  });
});

describe("SecurityScheme", () => {
  test("names its scheme by member and holds exactly one", () => {
    expect(
      securitySchemeSchema.safeParse({
        apiKeySecurityScheme: { location: "header", name: "X-Key" },
      }).success
    ).toBe(true);
    expect(
      securitySchemeSchema.safeParse({
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              scopes: { read: "Read" },
              tokenUrl: "https://auth.example/token",
            },
          },
        },
      }).success
    ).toBe(true);
    expect(
      securitySchemeSchema.safeParse({ mtlsSecurityScheme: {} }).success
    ).toBe(true);
    expect(securitySchemeSchema.safeParse({}).success).toBe(false);
    expect(
      securitySchemeSchema.safeParse({
        apiKeySecurityScheme: { location: "header", name: "X-Key" },
        httpAuthSecurityScheme: { scheme: "Bearer" },
      }).success
    ).toBe(false);
  });

  test("OAuth flows hold exactly one flow", () => {
    expect(
      securitySchemeSchema.safeParse({ oauth2SecurityScheme: { flows: {} } })
        .success
    ).toBe(false);
  });
});

describe("what Hermes sends", () => {
  test("its text message parses, mediaType and all", () => {
    const message = messageSchema.parse(hermesMessage);
    expect(message.parts[0]?.text).toBe("Summarise the open pull requests");
    expect(message.parts[0]?.mediaType).toBe("text/plain");
    expect(message.contextId).toBe("ctx-hermes-1");
    expect(
      sendMessageRequestSchema.safeParse({ message: hermesMessage }).success
    ).toBe(true);
  });

  test("its card parses and reads its bearer scheme in the proto's shape", () => {
    const card = agentCardSchema.parse(hermesCard);
    expect(card.name).toBe("Hermes");
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe("JSONRPC");
    expect(card.securitySchemes?.bearer).toEqual({
      httpAuthSecurityScheme: {
        bearerFormat: undefined,
        description: undefined,
        scheme: "bearer",
      },
    });
    expect(card.skills).toHaveLength(2);
  });

  test("unknown fields are ignored and dropped", () => {
    const card = agentCardSchema.parse(hermesCard) as Record<string, unknown>;
    expect(card.url).toBeUndefined();
    expect(card.security).toBeUndefined();
    const part = partSchema.parse({ future: 1, text: "hi" }) as Record<
      string,
      unknown
    >;
    expect(part.text).toBe("hi");
    expect(part.future).toBeUndefined();
    expect(
      messageSchema.safeParse({ ...userMessage, somethingNew: true }).success
    ).toBe(true);
  });

  test("a proto member next to the legacy fields is not overridden", () => {
    const parsed = securitySchemeSchema.safeParse({
      apiKeySecurityScheme: { location: "header", name: "k" },
      scheme: "bearer",
      type: "http",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toHaveProperty("apiKeySecurityScheme");
    expect(parsed.data).not.toHaveProperty("httpAuthSecurityScheme");
  });

  test("the legacy http scheme is read as bearer, a legacy scheme without one is refused", () => {
    expect(
      securitySchemeSchema.parse({ scheme: "bearer", type: "http" })
    ).toMatchObject({ httpAuthSecurityScheme: { scheme: "bearer" } });
    expect(securitySchemeSchema.safeParse({ type: "http" }).success).toBe(
      false
    );
    expect(
      securitySchemeSchema.safeParse({
        in: "header",
        name: "k",
        type: "apiKey",
      }).success
    ).toBe(false);
  });

  test("a security requirement may be empty, as ProtoJSON writes an empty map", () => {
    expect(
      agentCardSchema.safeParse({ ...sampleCard, securityRequirements: [{}] })
        .success
    ).toBe(true);
  });

  test("a 0.3 kind part is still refused next to the tolerance", () => {
    expect(
      messageSchema.safeParse({
        ...hermesMessage,
        parts: [{ kind: "text", mediaType: "text/plain", text: "hi" }],
      }).success
    ).toBe(false);
  });
});
