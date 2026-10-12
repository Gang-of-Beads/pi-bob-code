// The bob five-step pipeline, as a pi-subagents workflow script.
// The pi-bob-code extension's gate loads it through workflowScriptPath; the main session scouts first and passes args:
//   files/srcFiles/testFiles/acs/base: the changed files, the source and test files among them, AC tags, the diff base;
//   config: { verifyCommand, scoutAgent, fixerAgent, qaAgent, maxFindings, chunkSize, anchorsPath?, archRules?, repoPath? }
// Sandbox primitives: runs.run(key,{agent,task}) and runs.all([{key,agent,task}]). Subagents answer with plain JSON text, parsed leniently here.

const files = (args && args.files) || []
const srcFiles = (args && args.srcFiles && args.srcFiles.length ? args.srcFiles : files.filter((f) => f.indexOf('src/') === 0))
const testFiles = (args && args.testFiles && args.testFiles.length ? args.testFiles : files.filter((f) => f.indexOf('test/') === 0))
const acs = (args && args.acs) || []
const base = (args && args.base) || 'uncommitted working-tree changes'
const cfg = (args && args.config) || {}
const VERIFY = cfg.verifyCommand || 'npm test'
const SCOUT = cfg.scoutAgent || 'scout'
const FIXER = cfg.fixerAgent || 'worker'
const QA = cfg.qaAgent || 'scout'
const CAP = cfg.maxFindings || 4
const CHUNK = cfg.chunkSize || 3
const REPO = 'Repository: ' + (cfg.repoPath || 'the current working directory') + '. Diff base for this change: ' + base + '. '
const RULES = (cfg.archRules ? 'Architecture invariants (a violation means refuted): ' + cfg.archRules + '\n' : '') +
  (cfg.anchorsPath ? 'First read ' + cfg.anchorsPath + ' and note every anchor line; fixes must keep them verbatim.\n' : '') +
  'Report only what tools cannot see: lying comments, dead code, duplicated logic, misleading names, a function doing two things, error messages that lie, test assertions weaker than what they promise. Fewer, real findings beat many.'

// Lenient JSON extraction: strip ``` fences, take the first balanced {} or []. Returns the fallback when a subagent ignores the format.
function jparse(text, fallback) {
  if (!text) return fallback
  let s = String(text).replace(/```(json)?/g, '').trim()
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0)
  if (!starts.length) return fallback
  const open = s[starts[0] === -1 ? s.indexOf('[') : Math.min.apply(null, starts)]
  const close = open === '{' ? '}' : ']'
  const end = s.lastIndexOf(close)
  if (end <= starts[0]) return fallback
  try { return JSON.parse(s.slice(s.indexOf(open), end + 1)) } catch { return fallback }
}

if (files.length === 0) return { note: 'no changed files; the pipeline did not start' }

const finders = []
if (acs.length) {
  finders.push({ key: 'findAcAudit', prompt: 'Spec step: this change adds or changes acceptance promises: ' + acs.join(', ') + '. Read the matching Given/When/Then lines in test/acceptance.md (if present), then grep the tests tagged with them, and judge for each whether its assertions really verify every clause of the promise (failure paths included). A test titled with an AC whose assertions are weak = high.' })
} else if (testFiles.length) {
  finders.push({ key: 'findTestStrength', prompt: 'Spec step: this change touches the tests ' + testFiles.join(', ') + '. For each new or changed case, judge whether its assertions really verify the core promise of the behaviour under test (only checking ok:true, only the happy path, always-true assertions, or a promise in a comment with no assertion behind it = a finding; weak assertions = high).' })
}
if (srcFiles.length <= CHUNK) {
  for (const f of srcFiles) {
    finders.push({ key: 'findClean' + f.split('/').pop().replace(/[^a-zA-Z0-9]/g, ''), prompt: 'Cleanliness step: read all of ' + f + ', focusing on whether the changed functions agree with the code around them. Lenses: lying comments, dead code, duplication, misleading names, error messages that lie.' })
  }
} else {
  for (let i = 0; i < srcFiles.length; i += CHUNK) {
    finders.push({ key: 'findClean' + (i / CHUNK + 1), prompt: 'Cleanliness step: read the changed parts of ' + srcFiles.slice(i, i + CHUNK).join(', ') + ' and the code directly around them. Lenses: lying comments, dead code, duplication, misleading names, error messages that lie.' })
  }
}
const WRITE_PATH = cfg.writePaths || ['src/api/', 'src/db/', 'src/runner', 'src/executor/', 'src/verifier/']
if (srcFiles.some((f) => WRITE_PATH.some((p) => f.indexOf(p) === 0))) {
  finders.push({ key: 'findHarden', prompt: 'Hardening step (adversarial): review the concurrency, boundary, cancellation and idempotency semantics of this change: optimistic-lock windows, UNIQUE races, transaction boundaries, NULL predicates, cancellation windows, idempotency-key collisions, re-entry. Report only what you can show with a concrete triggering sequence.' })
}

const found = (await runs.all(finders.map((f) => ({
  key: f.key,
  agent: SCOUT,
  task: 'You are a read-only scout: do not edit or create files; gather evidence only with Read/Grep and read-only git diff commands. ' + REPO + RULES + '\n\n' + f.prompt + '\n\nOutput only JSON (no fences, no explanation): {"findings":[{"file","line","title","evidence" (copied verbatim from the source),"why","fix","severity":"high|medium|low"}]}. With no findings, output {"findings":[]}.',
})))).map((r) => jparse(r && r.output, { findings: [] }).findings || []).flat()

if (found.length === 0) return { total: 0, confirmed: [], deferred: [], fix: null, qa: null, note: 'no findings; the code was not touched' }

const seen = new Set()
const deduped = []
for (const f of found) {
  const k = ((f.file || '') + '|' + (f.title || '')).toLowerCase().slice(0, 80)
  if (f.file && f.title && !seen.has(k)) { seen.add(k); deduped.push(f) }
}
const rank = { high: 0, medium: 1, low: 2 }
deduped.sort((a, b) => ((rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)))
const capped = deduped.slice(0, CAP)
const deferred = deduped.slice(CAP)

const verifyResults = await runs.all(capped.map((f, i) => ({
  key: 'verify' + (i + 1),
  agent: SCOUT,
  task: 'You are an adversarial verifier. Your job is to refute the code-review finding below, not to agree with it. ' + REPO + (cfg.anchorsPath ? 'First read ' + cfg.anchorsPath + ' and note every anchor line.\n' : '') + 'Finding:\n' + JSON.stringify(f, null, 1) + '\nRefutation checklist (failing any one means real:false):\n1) Grep that the evidence quote exists verbatim in that file; not found = refuted.\n2) Read the context and judge whether the why holds; a historical problem unrelated to this change = refuted.\n3) A fix that changes an anchor line = refuted.\n4) A fix that breaks an architecture invariant = refuted.' + (cfg.archRules ? ' Invariants: ' + cfg.archRules : '') + '\n5) Is the fix really better than what is there? Change for its own sake = refuted.\nUnsure = real:false. Answer real:true only if you would vouch for the fixed result, and make revised_fix precise enough to apply as written.\nOutput only JSON: {"real":bool,"reason":"...","revised_fix":"..."}.',
})))

const confirmed = []
for (let i = 0; i < capped.length; i++) {
  const v = jparse(verifyResults[i] && verifyResults[i].output, null)
  if (v && v.real === true) confirmed.push({ f: capped[i], v })
}

if (confirmed.length === 0) return { total: deduped.length, confirmed: [], deferred, fix: null, qa: null, note: 'every finding was refuted; the code was not touched' }

const fixIn = JSON.stringify(confirmed.map((x) => ({
  severity: x.f.severity, file: x.f.file, line: x.f.line, title: x.f.title,
  evidence: x.f.evidence, why: x.f.why, fix: x.v.revised_fix || x.f.fix, verify_reason: x.v.reason,
})), null, 1)
const fixRules = 'Rules: 1) ' + (cfg.anchorsPath ? 'First read ' + cfg.anchorsPath + ' and keep its anchor lines verbatim.\n2) ' : '') + 'Keep behaviour unchanged unless the finding itself is a behaviour bug; fixing a bug means strengthening the test assertions with it.\n3) Match the style of the surrounding code.\n4) Do not run any tests (the gate step runs them).\n5) If one fix would reach too far, skip it with the reason rather than leave it half done.'
const fixOut = await runs.run('fix', {
  agent: FIXER,
  task: 'You are the fixer. ' + REPO + 'Apply the following confirmed review findings one by one:\n' + fixIn + '\n\n' + fixRules + '\nOutput only JSON: {"applied":[{"file","change"}],"skipped":[{"title","reason"}]}',
})
const fixReport = jparse(fixOut && fixOut.output, { applied: [], skipped: [] })

const qaOnce = () => runs.run('qa', {
  agent: QA,
  task: 'You are the QA gate. ' + REPO + 'At the repository root run: ' + VERIFY + ' . Never run it twice at once. All green = passed:true; anything red = passed:false, with the key errors (file:line) in failures. In summary give: test count, passed count, typecheck result.\nOutput only JSON: {"passed":bool,"summary":"...","failures":"..."}',
})
let qa = jparse((await qaOnce()).output, { passed: false, summary: 'QA returned no valid JSON', failures: 'QA output could not be parsed' })
let attempts = 0
while (qa && qa.passed === false && attempts < 2) {
  attempts++
  const repair = await runs.run('repair' + attempts, {
    agent: FIXER,
    task: 'You are the fixer (gate repair loop, round ' + attempts + '). ' + REPO + 'Code was changed earlier to apply review findings, and now the gate is red:\n' + (qa.failures || qa.summary) + '\nWhat the fix step changed:\n' + JSON.stringify(fixReport, null, 1) + '\nThe original task:\n' + fixIn + '\n\n' + fixRules + '\nSmallest change that turns it green first.\nOutput only JSON: {"applied":[{"file","change"}],"skipped":[{"title","reason"}]}',
  })
  jparse(repair && repair.output, { applied: [], skipped: [] })
  qa = jparse((await qaOnce()).output, qa)
}

return {
  total: deduped.length,
  confirmed: confirmed.map((x) => ({ severity: x.f.severity, file: x.f.file, title: x.f.title })),
  deferred: deferred.map((f) => ({ severity: f.severity, file: f.file, title: f.title })),
  fix: fixReport,
  qa: qa,
  attempts: attempts,
}
