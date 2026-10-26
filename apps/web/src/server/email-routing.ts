// The Cloudflare Email Routing adapter for `EmailRoutingPort`. It keeps one
// literal rule per agent address, which sends the mail to the Worker. Each
// rule is named `harbourmaster:<address>`, so `findRule` can tell our rules
// from others on the zone. Every method throws `RoutingNotConfiguredError`
// before it makes a request when the token, zone or Worker name is missing.
import {
  type EmailRoutingPort,
  RoutingNotConfiguredError,
} from "@repo/services/mail/types";
import { z } from "zod";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface EmailRoutingOptions {
  fetch?: FetchLike;
  token: string | undefined;
  workerName: string | undefined;
  zoneId: string | undefined;
}

const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 50;
const LIMIT_PATTERN = /limit|maximum/i;
const LIMIT_MESSAGE =
  "Email Routing rule limit reached for this domain (about 200 rules)";
const NOT_FOUND_CODE = "not found";

const errorSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string(),
});

const envelopeSchema = z.object({
  errors: z.array(errorSchema).default([]),
  result: z.unknown(),
  result_info: z.object({ total_pages: z.number().optional() }).optional(),
  success: z.boolean(),
});

type Envelope = z.infer<typeof envelopeSchema>;

const matcherSchema = z.object({
  field: z.string().optional(),
  type: z.string(),
  value: z.string().optional(),
});

const ruleSchema = z.object({
  id: z.string(),
  matchers: z.array(matcherSchema).default([]),
  name: z.string().optional(),
});

const createdRuleSchema = z.object({ id: z.string() });
const ruleListSchema = z.array(ruleSchema);

interface Config {
  rulesUrl: string;
  send: FetchLike;
  token: string;
  workerName: string;
}

const readEnvelope = async (
  response: Response
): Promise<Envelope | undefined> => {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = envelopeSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
};

/** Builds the error for a failed call. The token never reaches the message. */
const failure = (
  envelope: Envelope | undefined,
  status: number,
  token: string
): Error => {
  const messages = envelope?.errors.map((error) => error.message) ?? [];
  const text = messages.length > 0 ? messages.join("; ") : `HTTP ${status}`;
  const detail = LIMIT_PATTERN.test(text)
    ? LIMIT_MESSAGE
    : `Cloudflare Email Routing: ${text}`;
  return new Error(detail.replaceAll(token, "[redacted]"));
};

const request = (config: Config, url: string, init: RequestInit) =>
  config.send(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
  });

/** Calls the API, checks the envelope and parses its `result` with `schema`. */
const call = async <T extends z.ZodType>(
  config: Config,
  url: string,
  init: RequestInit,
  schema: T
): Promise<{ result: z.output<T>; resultInfo: Envelope["result_info"] }> => {
  const response = await request(config, url, init);
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope?.success !== true) {
    throw failure(envelope, response.status, config.token);
  }
  const parsed = schema.safeParse(envelope.result);
  if (!parsed.success) {
    throw new Error("Cloudflare Email Routing: unexpected response");
  }
  return { result: parsed.data, resultInfo: envelope.result_info };
};

export const createEmailRoutingPort = ({
  token,
  zoneId,
  workerName,
  fetch: send = (input, init) => fetch(input, init),
}: EmailRoutingOptions): EmailRoutingPort => {
  const settings = (): Config => {
    if (!(token && zoneId && workerName)) {
      throw new RoutingNotConfiguredError();
    }
    return {
      rulesUrl: `${API_ORIGIN}/zones/${zoneId}/email/routing/rules`,
      send,
      token,
      workerName,
    };
  };

  return {
    createRule: async (address) => {
      const config = settings();
      const target = address.toLowerCase();
      const { result } = await call(
        config,
        config.rulesUrl,
        {
          body: JSON.stringify({
            actions: [{ type: "worker", value: [config.workerName] }],
            enabled: true,
            matchers: [{ field: "to", type: "literal", value: target }],
            name: `harbourmaster:${target}`,
          }),
          method: "POST",
        },
        createdRuleSchema
      );
      return { id: result.id };
    },

    deleteRule: async (ruleId) => {
      const config = settings();
      const response = await request(
        config,
        `${config.rulesUrl}/${encodeURIComponent(ruleId)}`,
        { method: "DELETE" }
      );
      if (response.status === 404) {
        return;
      }
      const envelope = await readEnvelope(response);
      if (response.ok && envelope?.success === true) {
        return;
      }
      if (envelope?.errors.some((error) => error.code === NOT_FOUND_CODE)) {
        return;
      }
      throw failure(envelope, response.status, config.token);
    },

    findRule: async (address) => {
      const config = settings();
      const target = address.toLowerCase();
      const name = `harbourmaster:${target}`;
      for (let page = 1; ; page += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: each page's total_pages decides whether to fetch the next
        const { result: rules, resultInfo } = await call(
          config,
          `${config.rulesUrl}?page=${page}&per_page=${PAGE_SIZE}`,
          {},
          ruleListSchema
        );
        const match = rules.find((rule) =>
          rule.matchers.some(
            (matcher) =>
              matcher.type === "literal" &&
              matcher.field === "to" &&
              matcher.value?.toLowerCase() === target
          )
        );
        if (match) {
          return { id: match.id, managed: match.name === name };
        }
        // Some list endpoints send no total_pages, so then a short page ends the list.
        const lastPage = resultInfo?.total_pages;
        if (
          lastPage === undefined
            ? rules.length < PAGE_SIZE
            : page >= lastPage || rules.length === 0
        ) {
          return null;
        }
      }
    },
  };
};
