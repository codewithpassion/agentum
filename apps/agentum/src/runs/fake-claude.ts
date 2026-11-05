/** biome-ignore-all lint/suspicious/noMisplacedAssertion: This executable asserts the driver contract on behalf of Rust tests. */
// Only tests launch this executable. No SDK or real Claude process is used.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const messages = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
if (process.argv.includes("--version")) {
  console.log("2.1.310 (Fake Claude)");
  process.exit(0);
}
const expectedPath = process.argv[3] ?? "";
const expected = existsSync(expectedPath)
  ? JSON.parse(readFileSync(expectedPath, "utf8"))
  : {};
writeFileSync("pid", String(process.pid));
let stage = 0;
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (stage === 0) {
    if (
      frame.request.subtype !== "initialize" ||
      (frame.request.hooks &&
        frame.request.hooks.PreToolUse[0].timeout !== 90_000) ||
      !frame.request.appendSystemPrompt.includes("Your files live") ||
      process.env.CLAUDE_CODE_ENTRYPOINT !== "sdk-ts" ||
      process.env.CLAUDECODE
    ) {
      process.exit(21);
    }
    const argv = [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--thinking",
      "adaptive",
      "--thinking-display",
      "summarized",
      "--max-turns",
      "100",
      "--model",
      "fake",
      "--setting-sources=project",
      "--strict-mcp-config",
      "--permission-mode",
      "bypassPermissions",
      "--allow-dangerously-skip-permissions",
      ...(frame.request.hooks ? ["--permission-prompt-tool", "stdio"] : []),
    ];
    assert.deepEqual(process.argv.slice(4), expected.argv ?? argv);
    if (expected.env) {
      assert.deepEqual(process.env, expected.env);
    }
    if (expected.cwd) {
      assert.equal(process.cwd(), expected.cwd);
    }
    assert(!Object.values(process.env).includes("run-secret"));
    for (const path of [".claude", "inbox", "tmp"]) {
      assert(existsSync(path));
    }
    assert(!existsSync(".mcp.json"));
    send({
      response: {
        request_id: frame.request_id,
        response: {},
        subtype: "success",
      },
      type: "control_response",
    });
    stage += 1;
  } else if (stage === 1) {
    if (frame.request.subtype !== "mcp_set_servers") {
      process.exit(22);
    }
    if (expected.holdMcp) {
      writeFileSync("mcp-wait", "yes");
      continue;
    }
    send({
      response: {
        request_id: frame.request_id,
        response: { added: ["test"], errors: { broken: "unreachable" } },
        subtype: expected.mcpError ? "error" : "success",
      },
      type: "control_response",
    });
    stage += 1;
  } else if (stage === 2) {
    if (frame.type !== "user") {
      process.exit(23);
    }
    writeFileSync("ready", "yes");
    if (expected.mode === "stderr") {
      console.error("failure run-secret");
      process.exit(0);
    }
    if (expected.mode === "plain-error") {
      send({
        errors: ["plain error"],
        session_id: "kept",
        subtype: "error_during_execution",
        type: "result",
      });
      break;
    }
    if (expected.mode === "elicitation") {
      send({
        request: { subtype: "elicitation" },
        request_id: "elicit",
        type: "control_request",
      });
      stage = 7;
      continue;
    }
    if (expected.mode === "question" || expected.mode === "waiting") {
      send({
        message: { content: [{ text: "waiting", type: "text" }] },
        type: "assistant",
      });
      send({
        request: {
          callback_id: "hook_0",
          input: {
            hook_event_name: "PreToolUse",
            tool_input:
              expected.mode === "question"
                ? { questions: [{ question: "Pick?" }] }
                : { command: "echo yes" },
            tool_name:
              expected.mode === "question" ? "AskUserQuestion" : "Bash",
            tool_use_id: "q",
          },
          subtype: "hook_callback",
        },
        request_id: "question",
        type: "control_request",
      });
      stage = 8;
      continue;
    }
    if (expected.mode === "secrets") {
      for (const value of Object.values(expected.secrets)) {
        send({
          message: { content: [{ text: value, type: "text" }] },
          type: "assistant",
        });
      }
    }
    if (frame.message.content === "many") {
      for (let index = 0; index < 205; index += 1) {
        send({
          message: { content: [{ text: `message ${index}`, type: "text" }] },
          type: "assistant",
        });
      }
      send(messages.at(-1));
      break;
    }
    if (expected.mode === "delayed-result") {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (existsSync("release")) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
      });
      for (let i = 0; i < 2000; i += 1) {
        send({
          message: { content: [{ text: "x".repeat(200), type: "text" }] },
          type: "assistant",
        });
      }
      send(messages.at(-1));
      continue;
    }
    if (frame.message.content === "hold") {
      continue;
    }
    if (frame.message.content === "fail") {
      send({
        errors: [],
        session_id: "session",
        subtype: "error_max_turns",
        type: "result",
        usage: {},
      });
      break;
    }
    if (frame.message.content === "cancel-control") {
      send({
        request: {
          callback_id: "hook_0",
          input: {
            hook_event_name: "PreToolUse",
            tool_input: {},
            tool_name: "Bash",
            tool_use_id: "cancelled",
          },
          subtype: "hook_callback",
        },
        request_id: "cancel-me",
        type: "control_request",
      });
      send({ request_id: "cancel-me", type: "control_cancel_request" });
      stage = 6;
      continue;
    }
    if (frame.message.content === "controls") {
      send({
        request: { subtype: "future" },
        request_id: "unknown",
        type: "control_request",
      });
      stage += 1;
      continue;
    }
    for (const message of messages) {
      send(message);
    }
    break;
  } else if (stage === 7) {
    assert.deepEqual(frame.response.response, { action: "decline" });
    for (const message of messages) {
      send(message);
    }
    break;
  } else if (stage === 8) {
    writeFileSync("verdict", JSON.stringify(frame));
    if (expected.mode === "question") {
      assert.equal(
        frame.response.response.hookSpecificOutput.permissionDecision,
        "allow"
      );
    } else {
      assert.equal(
        frame.response.response.hookSpecificOutput.permissionDecision,
        "deny"
      );
    }
    for (const message of messages) {
      send(message);
    }
    break;
  } else if (stage === 3) {
    if (frame.response.subtype !== "error") {
      process.exit(24);
    }
    send({
      request: {
        input: {},
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "t",
      },
      request_id: "can",
      type: "control_request",
    });
    stage += 1;
  } else if (stage === 4) {
    if (frame.response.response.behavior !== "allow") {
      process.exit(25);
    }
    send({
      request: {
        callback_id: "hook_0",
        input: {
          hook_event_name: "PreToolUse",
          tool_input: { command: "echo yes" },
          tool_name: "Bash",
          tool_use_id: "t",
        },
        subtype: "hook_callback",
      },
      request_id: "hook",
      type: "control_request",
    });
    stage += 1;
  } else if (stage === 6) {
    if (
      frame.response.response.hookSpecificOutput.permissionDecision !== "deny"
    ) {
      process.exit(27);
    }
    for (const message of messages) {
      send(message);
    }
    break;
  } else if (stage === 5) {
    if (
      frame.response.response.hookSpecificOutput.permissionDecision !== "allow"
    ) {
      process.exit(26);
    }
    for (const message of messages) {
      send(message);
    }
    break;
  }
}

if (expected.mode === "delayed-result") {
  writeFileSync("input-closed", "yes");
}

if (expected.mode === "completion-delay") {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
