# pi-bob-code

A [pi](https://github.com/earendil-works/pi) extension that puts every code change through review before the agent may finish: **edit source, and the finish is gated until a five-step pipeline has checked the change and the gate command is green**.

## What it does

```
An edit under srcPaths ──→ sets the .git/bob-pending marker
The agent tries to finish (agent_settled) ──marker found──→ stopped; the pipeline instructions are injected
  (only when the run completed: a run the user stopped, or one that ended in a provider error, is left alone)
The bob pipeline (a pi-subagents workflow, workflows/bob-pipeline.js):
  1. Scout      parallel read-only reviews: spec (do the test assertions keep their promise),
                cleanliness (chunkSize files each), hardening (only when the change touches writePaths)
  2. Verify     each finding goes to a skeptic whose job is to refute it; at most maxFindings
                go in, the rest are reported as deferred
  3. Fix        one fixer applies the confirmed findings in order (anchor lines kept verbatim, no tests run)
  4. Gate       a QA subagent runs verifyCommand; red goes back to the fixer, at most twice
  5. Report     the main session lists what was confirmed, refuted and fixed and the gate result,
                then runs verifyCommand again itself as a second vote
```

Why the adversarial step: scouts report many plausible problems. Each finding goes on its own to a skeptic told to refute it. A quote that is not in the file, a problem unrelated to this change, a fix that touches an anchor line or breaks an invariant, a change for its own sake: any one of these rejects it. Only findings the skeptic would vouch for reach the fixer. In the reviews run on [PI WEB](https://github.com/Gang-of-Beads/pi-web), more than half of the findings were rejected at this step.

## Install

```bash
pi install git:github.com/Gang-of-Beads/pi-bob-code
```

It needs [pi-subagents](https://github.com/nicobailon/pi-subagents): the pipeline is a pi-subagents workflow script, and the subagent names must match agents registered there (by default `scout` scouts, verifies and runs QA; `worker` fixes).

## Configure (optional)

Put `bob.config.json` (or `.pi/bob.config.json`) at the project root. Every field is optional:

```json
{
  "srcPaths": ["src/", "lib/"],
  "writePaths": ["src/api/", "src/db/"],
  "verifyCommand": "npm test",
  "scoutAgent": "scout",
  "fixerAgent": "worker",
  "qaAgent": "scout",
  "maxFindings": 4,
  "chunkSize": 3,
  "anchorsPath": "test/mutation.ts",
  "archRules": "writes to tasks/evidence go only through src/api/actions.ts; the verifier never imports the runner",
  "extraWriteTools": []
}
```

- `srcPaths`: an edit under one of these path prefixes sets the pending marker (so does a path containing `/test/`)
- `writePaths`: only a change that touches one of these gets the hardening step (concurrency, boundaries, cancellation, idempotency); it is the most expensive step, so it is not spent on wording changes
- `verifyCommand`: the gate command; the QA subagent runs it and the main session runs it again
- `anchorsPath`: a mutation-test anchor file; when present, fixes must keep its anchor lines verbatim
- `archRules`: architecture invariants; a finding or a fix that breaks one is rejected
- `extraWriteTools`: tool names that also count as writing a file, besides `write`, `edit`, `apply_patch` and `multiedit`

A real example, abridged from the [PI WEB](https://github.com/Gang-of-Beads/pi-web) repository's `bob.config.json`:

```json
{
  "srcPaths": ["src/", "pi-web-plugins/", "extensions/"],
  "writePaths": ["src/server/", "src/shared/", "src/client/src/controllers/", "src/client/src/api/", "src/client/src/sync/"],
  "verifyCommand": "pnpm run verify",
  "maxFindings": 4,
  "chunkSize": 3,
  "archRules": "src/server/web/ never imports src/server/daemon/ and the reverse; a plugin under pi-web-plugins/ imports nothing from the host source; no state is decided by comparing display text; no new inline comments."
}
```

When it starts the pipeline, the main session may also override `verifyCommand`, `maxFindings`, `fixerAgent` and `archRules` per run in `args.config`, and pass `repoPath`. Writing the change's design notes and a list of suspicions to hunt into `archRules` makes the review noticeably sharper.

## Commands

| Command | What it does |
|---|---|
| `/bob` | Run the pipeline on the current changes by hand |
| `/bob-done` | Clear the markers, explicitly waiving this round's check |

## Known issues

Found over several weeks of daily use on PI WEB, and not fixed yet:

- **The "pipeline is running" pass never applies.** The extension reads the *contents* of `.git/bob-running` as a timestamp, while the gate tells the main session to `touch` the file. An empty file reads as 0 and always counts as stale, so while the pipeline runs, every finish is gated again, including the fixer's own. Reading the file's modification time instead, or writing `Date.now()` into it, would fix it.
- **The fixer's session loads the extension too.** When the fixer edits a file under `srcPaths`, its own finish is gated, and it asks the main session what to do. Answer that the main session owns the gate, and that the fixer should run no tests and start nothing.
- **The QA subagent's environment can differ from the main session's** (PATH, package-manager version), so the gate can go red because of the environment rather than the code. That is why step 5's independent run matters: when the two votes disagree, trust the independent run and find out why.
- **The gate asks the main session to wait for the pipeline**, so the session is blocked until the pipeline ends or the user sends a new message.

## Design notes

- **Markers live in `.git/`**: outside the working tree and never tracked. Without `.git`, they fall back to `.pi/`.
- **The gate is an `agent_settled` handler that injects a follow-up turn** rather than a hard block: in pi's event model, stopping a finish means starting another turn, which keeps it out of the way of auto-compaction and retries.
- **Stop means stop**: when the run settled because the user aborted it (`agent_settled`'s `aborted`, or a last assistant message with stop reason `aborted`), the gate neither injects nor records an injection. A run that ended in a provider error is treated the same way: pi has already spent its automatic retries, and an injected turn would most likely fail again and use up this change's one injection. The marker stays, so the next completed finish is gated once.
- **A 30-minute staleness window**: markers left behind by a crashed session stop gating after half an hour.
- **JSON in text rather than a schema**: subagent output is parsed leniently (fences stripped, the first balanced block taken). A parse failure degrades to "no findings from this step" or "gate not passed", never to a false pass.
- **Living with pi-multi-account**: switching accounts replaces the session, so the old instance's `agent_settled` may meet a stale context. The extension gives up quietly; the marker stays in `.git/` and the new session's instance gates as usual.

## Development

```bash
npx jiti test/agent-settled.test.ts
```

## License

[MIT](LICENSE).
