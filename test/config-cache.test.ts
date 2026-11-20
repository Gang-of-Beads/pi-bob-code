/**
 * Self-check for the tool_call fast path: the config and the .git/marker directory are resolved
 * once per cwd. A later call on the same cwd therefore keeps using what the first one read, and
 * another cwd resolves on its own instead of inheriting the first one's answer.
 * Run with: node --test test/config-cache.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bob from "../extensions/pi-bob-code.ts";

const root = mkdtempSync(join(tmpdir(), "bob-config-cache-"));
const first = join(root, "first");
const second = join(root, "second");
mkdirSync(join(first, ".git"), { recursive: true });
mkdirSync(join(second, ".pi"), { recursive: true });
writeFileSync(join(first, "bob.config.json"), JSON.stringify({ extraWriteTools: ["notepad"] }));

const handlers: Record<string, (event: any, ctx: any) => Promise<void>> = {};
bob({ on: (name: string, handler: any) => { handlers[name] = handler; }, registerCommand: () => {}, sendUserMessage: async () => {} } as any);

const caller = (cwd: string) => ({ cwd, sessionManager: { getSessionId: () => "s1", getBranch: () => [] } });
const pending = (cwd: string) =>
  existsSync(join(cwd, ".git", "bob-pending")) ? "git" : existsSync(join(cwd, ".pi", "bob-pending")) ? "pi" : "none";

try {
  await handlers.tool_call({ toolName: "notepad", input: { path: "src/a.ts" } }, caller(first));
  assert.equal(pending(first), "git", "a configured extra write tool marks a pending change");

  // The disk now says otherwise: an empty config, and .git kept only so a marker can still be written.
  writeFileSync(join(first, "bob.config.json"), "{}");
  rmSync(join(first, ".git"), { recursive: true, force: true });
  mkdirSync(join(first, ".git"));

  await handlers.tool_call({ toolName: "notepad", input: { path: "src/a.ts" } }, caller(first));
  assert.equal(pending(first), "git", "the config is read once per cwd, not on every call");

  await handlers.tool_call({ toolName: "notepad", input: { path: "src/a.ts" } }, caller(second));
  assert.equal(pending(second), "none", "another cwd without that config does not inherit it");

  await handlers.tool_call({ toolName: "edit", input: { path: "src/a.ts" } }, caller(second));
  assert.equal(pending(second), "pi", "without .git the markers go to .pi");

  // Same cwd, now with a .git: the resolved marker directory stays.
  mkdirSync(join(second, ".git"));
  rmSync(join(second, ".pi", "bob-pending"));

  await handlers.tool_call({ toolName: "edit", input: { path: "src/a.ts" } }, caller(second));
  assert.equal(pending(second), "pi", "the marker directory is resolved once per cwd");

  console.log("config-cache: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
