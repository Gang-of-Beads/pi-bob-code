// pi-bob-code: a pi extension that puts every code change through a five-step pipeline
// (scout → adversarial verification → fix → gate → report) before the agent may finish.
// Repository paths, the gate command and the subagents come from bob.config.json.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit"]);
const STALE_MS = 30 * 60 * 1000;

type BobConfig = {
  srcPaths: string[];        // path prefixes that count as source; an edit under one sets the pending marker
  verifyCommand: string;     // the gate command (run by the QA step and again by the main session)
  scoutAgent: string;        // subagent for scouting and adversarial verification
  fixerAgent: string;        // subagent that applies fixes (needs write access)
  qaAgent: string;           // subagent that runs the gate (needs bash)
  maxFindings: number;       // how many findings go on to adversarial verification
  chunkSize: number;         // files each cleanliness scout reads
  anchorsPath?: string;      // mutation-anchor file; when present, fixes must keep its lines verbatim
  archRules?: string;        // architecture invariants, written into the verify and fix rules
  extraWriteTools?: string[];// further tool names that count as writing a file
};

const DEFAULTS: BobConfig = {
  srcPaths: ["src/", "lib/", "app/"],
  verifyCommand: "npm test",
  scoutAgent: "scout",
  fixerAgent: "worker",
  qaAgent: "scout",
  maxFindings: 4,
  chunkSize: 3,
};

function loadConfig(cwd: string): BobConfig {
  const cfg: Partial<BobConfig> = {};
  for (const p of [join(cwd, "bob.config.json"), join(cwd, ".pi", "bob.config.json")]) {
    if (existsSync(p)) {
      try { Object.assign(cfg, JSON.parse(readFileSync(p, "utf8"))); break; } catch { /* a broken config falls back to the defaults */ }
    }
  }
  return { ...DEFAULTS, ...cfg };
}

function markerPath(cwd: string, name: string): string {
  // Markers live inside .git/: outside the working tree and never tracked. Without .git, fall back to .pi/.
  const dir = existsSync(join(cwd, ".git")) ? join(cwd, ".git") : join(cwd, ".pi");
  return join(dir, name);
}

function markPending(cwd: string) {
  try { writeFileSync(markerPath(cwd, "bob-pending"), String(Date.now())); } catch { /* read-only disk and similar: stay silent */ }
}

/** What was already delivered, as `<generation>\t<session>`: one injection per change. */
function injectedKey(cwd: string): string {
  try { return readFileSync(markerPath(cwd, "bob-injected"), "utf8"); } catch { return ""; }
}

function markInjected(cwd: string, generation: string, session: string): void {
  try { writeFileSync(markerPath(cwd, "bob-injected"), `${generation}\t${session}`); } catch { /* as above */ }
}

function pendingGeneration(cwd: string): string | undefined {
  try { return readFileSync(markerPath(cwd, "bob-pending"), "utf8").trim() || undefined; } catch { return undefined; }
}

/**
 * Whether this settle should inject, or stay quiet.
 *
 * Injecting on every settle while the marker exists was the original behaviour, and it loops:
 * one interrupted turn leaves the marker, the next settle injects the same instruction again,
 * and it reads as a gate that cannot be stopped while every copy costs a whole turn. The
 * record is keyed on the change generation and the session, so one change tells one session
 * once. Another session still gets told - the one able to run the pipeline is not necessarily
 * the one that settled, since a subagent writes files too and has no subagent tool.
 */
function shouldInject(cwd: string, session: string): boolean {
  const generation = pendingGeneration(cwd);
  if (!generation) return false;
  return injectedKey(cwd) !== `${generation}\t${session}`;
}

function pendingState(cwd: string): "none" | "pending" | "running" {
  const runningP = markerPath(cwd, "bob-running");
  try {
    if (existsSync(runningP)) {
      const mtime = Number(readFileSync(runningP, "utf8")) || 0;
      if (Date.now() - mtime < STALE_MS) return "running"; // the pipeline is running: let the session finish
    }
  } catch { /* fallthrough */ }
  return existsSync(markerPath(cwd, "bob-pending")) ? "pending" : "none";
}

function clearMarkers(cwd: string) {
  for (const n of ["bob-pending", "bob-running", "bob-injected"]) {
    try { unlinkSync(markerPath(cwd, n)); } catch { /* already gone is the goal */ }
  }
}

function touchesWatchedPath(cfg: BobConfig, p: string): boolean {
  if (!p) return false;
  return cfg.srcPaths.some((pre) => p.startsWith(pre)) || p.includes("/test/");
}

function workflowFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "bob-pipeline.js");
}

const BOB_PROMPT = (wf: string, verify: string) => `Run the bob five-step pipeline on the current code changes, in this order:

1. Scout (inline, yourself, no subagent): \`git status --short\` plus \`git diff --stat HEAD\` (staged changes included) give the changed files. If the working tree is clean, use \`git diff --name-only \$(git merge-base HEAD main)\` to see unchecked commits and put that base in \`base\`. Collect AC tags (regex AC-\\d+) from the titles of changed tests into \`acs\`, or an empty array. Shortcut: any edit under src/ this round goes through the pipeline; only a change of at most 2 files that is purely docs or config may skip it, by running \`${verify}\` directly and reporting.
2. Start the pipeline: first \`touch .git/bob-running\` (treated as stale after 30 minutes), then call the subagent tool with workflow: "${wf}" and args: { files, srcFiles, testFiles, acs, base }. Wait for the pipeline while it runs; do not finish with nothing to show.
3. Report: what was confirmed, refuted and fixed, and the gate result (a table); list deferred findings by severity.
4. Check independently: run \`${verify}\` again yourself (a second vote beside the pipeline's QA). Only agreement counts.
5. Wrap up: delete .git/bob-pending and .git/bob-running, then finish.

If this session has no \`subagent\` tool - a subagent session has none - do not keep asking: the \`touch .git/bob-running\` above already silences the gate, so just run \`${verify}\` once and leave the markers of this change to the session that can run the pipeline.`;

export default function (pi: ExtensionAPI) {
  let cwdCache = "";

  const cfgFor = (ctx: any): BobConfig => loadConfig(ctx.cwd || cwdCache || process.cwd());

  // 1. A write tool that touches a watched path sets the pending marker.
  pi.on("tool_call", async (event, ctx) => {
    cwdCache = ctx.cwd || cwdCache;
    if (!EDIT_TOOLS.has(event.toolName) && !(cfgFor(ctx).extraWriteTools ?? []).includes(event.toolName)) return;
    const input: any = event.input ?? {};
    const p: string = input.file_path ?? input.path ?? input.filePath ?? "";
    if (touchesWatchedPath(cfgFor(ctx), p)) markPending(ctx.cwd || process.cwd());
    return; // record only, never block the call
  });

  // 2. The finish gate: unchecked changes inject the pipeline instructions as a follow-up turn.
  //    When another extension (pi-multi-account, for one) replaces the session, this instance is stale:
  //    give up quietly and leave the marker for the new session's instance.
  pi.on("agent_settled", async (_event, ctx) => {
    const cwd = ctx.cwd || cwdCache || process.cwd();
    if (pendingState(cwd) !== "pending") return;
    const session = String(ctx.sessionManager?.getSessionId?.() ?? process.pid);
    if (!shouldInject(cwd, session)) return;
    const cfg = cfgFor(ctx);
    markInjected(cwd, pendingGeneration(cwd)!, session);
    try {
      await pi.sendUserMessage(
      `The bob gate stopped this finish: the working tree has unchecked code changes (this round edited ${cfg.srcPaths.join(" or ")}). Do not skip it because the code is dead or the behaviour is unchanged.\n\n` +
      BOB_PROMPT(workflowFilePath(), cfg.verifyCommand),
      { deliverAs: "followUp", triggerTurn: true } as any,
      );
    } catch (e) {
      if (!String(e).includes("stale")) throw e; // stale: the session was replaced and its new instance takes over
    }
  });

  // 3. /bob: run the pipeline by hand.
  pi.registerCommand("bob", {
    description: "Run the bob five-step pipeline on the current code changes (scout → verify → fix → gate)",
    handler: async (_args, ctx) => {
      const cfg = cfgFor(ctx);
      const session = String(ctx.sessionManager?.getSessionId?.() ?? process.pid);
      const generation = pendingGeneration(ctx.cwd);
      if (generation) markInjected(ctx.cwd, generation, session);
      try {
        await pi.sendUserMessage(BOB_PROMPT(workflowFilePath(), cfg.verifyCommand), {
          deliverAs: "followUp",
          triggerTurn: true,
        } as any);
      } catch (e) {
        if (!String(e).includes("stale")) throw e;
        ctx.ui.notify("The session was replaced; run /bob again in the new session", "warning");
      }
    },
  });

  // 4. Escape hatch: clear the markers when the user explicitly waives this round's check.
  pi.registerCommand("bob-done", {
    description: "Clear the bob-pending and bob-running markers (explicitly waive this round's check)",
    handler: async (_args, ctx) => {
      clearMarkers(ctx.cwd || process.cwd());
      await pi.sendUserMessage("bob markers cleared; this round's check is waived.", { triggerTurn: true } as any);
    },
  });
}
