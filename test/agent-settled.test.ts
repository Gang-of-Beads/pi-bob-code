/**
 * Self-check for the finish gate's agent_settled handler: an aborted or errored run neither
 * injects nor records an injection, and the next completed finish is still gated once.
 * Run with: npx jiti test/agent-settled.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bob from "../extensions/pi-bob-code.ts";

const cwd = mkdtempSync(join(tmpdir(), "bob-settled-"));
mkdirSync(join(cwd, ".git"));
writeFileSync(join(cwd, ".git", "bob-pending"), "1");

const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
const sent: string[] = [];
const pi: any = {
  on: (name: string, handler: any) => { handlers[name] = handler; },
  registerCommand: () => {},
  sendUserMessage: async (text: string) => { sent.push(text); },
};
bob(pi);

const ctxWithLast = (stopReason: string) => ({
  cwd,
  sessionManager: {
    getSessionId: () => "s1",
    getBranch: () => [{ type: "message", message: { role: "assistant", stopReason } }],
  },
});

try {
  await handlers.agent_settled({ type: "agent_settled", aborted: true }, ctxWithLast("aborted"));
  await handlers.agent_settled({ type: "agent_settled", aborted: true }, ctxWithLast("stop"));
  await handlers.agent_settled({ type: "agent_settled", aborted: false }, ctxWithLast("aborted"));
  await handlers.agent_settled({ type: "agent_settled", aborted: false }, ctxWithLast("error"));
  assert.equal(sent.length, 0, "an aborted or errored settle must not inject");
  assert.equal(existsSync(join(cwd, ".git", "bob-injected")), false, "an aborted or errored settle must not record an injection");

  await handlers.agent_settled({ type: "agent_settled", aborted: false }, ctxWithLast("stop"));
  assert.equal(sent.length, 1, "the next completed settle is gated");

  await handlers.agent_settled({ type: "agent_settled", aborted: false }, ctxWithLast("toolUse"));
  assert.equal(sent.length, 1, "the same change gates the same session once");
  console.log("agent-settled: ok");
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
