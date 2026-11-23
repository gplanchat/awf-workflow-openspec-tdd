// flow-review and egm-review.sh: the EGM reviewers run by a fake agent, the report, the question and the resume.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const available = spawnSync('awf', ['--help'], { encoding: 'utf8' }).status === 0;
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(PACK, 'scripts', 'egm-review.sh');
const work = mkdtempSync(join(tmpdir(), 'egm-review-'));
after(() => rmSync(work, { recursive: true, force: true }));

// A fake `claude` that logs its prompt and answers with $FAKE_FINDINGS.
const FAKE_CLAUDE = `#!/usr/bin/env bash
printf '%s\\n---\\n' "$*" >> "$(dirname "$0")/../claude.log"
if [[ -n \${FAKE_STDERR:-} ]]; then printf '%s\\n' "$FAKE_STDERR" >&2; exit 1; fi
if [[ -n \${FAKE_FINDINGS:-} ]]; then printf '%s\\n' "$FAKE_FINDINGS"; else echo '{"findings":[]}'; fi
`;

const BLOCKER = '{"findings":[{"severity":"Blocker","scope":"proposal.md:1","finding":"The proposal does not say why.","recommendation":"Add the motivation."},{"severity":"Nit","scope":"tasks.md","finding":"Terse task."}]}';

function project(): string {
  const root = mkdtempSync(join(work, 'p-'));
  for (const dir of ['.awf/workflows', '.awf/scripts', '.awf/prompts', 'bin', 'egm/agents', 'openspec/changes/demo/specs/cap']) mkdirSync(join(root, dir), { recursive: true });
  cpSync(join(PACK, 'workflows', 'flow-review.yaml'), join(root, '.awf', 'workflows', 'flow-review.yaml'));
  cpSync(join(PACK, 'prompts', 'egm-review.md'), join(root, '.awf', 'prompts', 'egm-review.md'));
  cpSync(join(PACK, 'skills', 'egm-reviewer'), join(root, '.awf', 'skills', 'egm-reviewer'), { recursive: true });
  for (const script of ['egm-review.sh', 'commands.sh']) cpSync(join(PACK, 'scripts', script), join(root, '.awf', 'scripts', script));
  writeFileSync(join(root, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  mkdirSync(join(root, 'egm', 'resources', 'document_standards'), { recursive: true });
  for (const persona of ['zoom_out', 'comprehension', 'design_critic', 'structural', 'style', 'implementation_readiness', 'codebase_details']) writeFileSync(join(root, 'egm', 'agents', `${persona}.md`), `---\nname: egm-${persona}\n---\n\nPERSONA ${persona}\n\n# Output Format\n\nPlain language.\n`);
  for (const standard of ['zoom-out-standard', 'feature-spec-standard', 'implementation-readiness-standard']) writeFileSync(join(root, 'egm', 'resources', 'document_standards', `${standard}.md`), `STANDARD ${standard}\n`);
  writeFileSync(join(root, 'openspec/changes/demo/proposal.md'), '# Demo\n');
  writeFileSync(join(root, 'openspec/changes/demo/design.md'), '# Design\n');
  writeFileSync(join(root, 'openspec/changes/demo/tasks.md'), '- [ ] 1.1 Do it\n');
  writeFileSync(join(root, 'openspec/changes/demo/specs/cap/spec.md'), '# Spec\n');
  return root;
}

const env = (root: string, extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, EGM_ROOT: join(root, 'egm'), ...extra });

function awf(root: string, args: string[], extra: Record<string, string> = {}, output = 'buffered') {
  const result = spawnSync('awf', [...args, '--output', output], { cwd: root, encoding: 'utf8', env: env(root, extra) });
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
  return { status: result.status, output: `${result.stdout}${result.stderr}`, report: JSON.parse(read('.awf/status/flow-review.json') || 'null') as Record<string, unknown> | null, prompts: read('claude.log'), review: read('.awf/status/egm/review.md') };
}

const script = (root: string, ...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: env(root) });

test('flow-review: seven reviewers with read-only tools, no Blocker, status clean', { skip: !available }, () => {
  const root = project();
  const run = awf(root, ['run', 'flow-review', '--input', 'change=demo']);

  assert.equal(run.status, 0, run.output);
  assert.equal(run.prompts.split('\n---\n').filter((p) => p.trim() !== '').length, 7);
  assert.equal(run.prompts.match(/--allowedTools Read,Grep,Glob/g)?.length, 7);
  assert.match(run.prompts, /<persona>\n\nPERSONA design_critic\n/);
  assert.doesNotMatch(run.prompts, /name: egm-/, 'the front matter of the persona is left out');
  assert.match(run.prompts, /<target_standard>\nSTANDARD implementation-readiness-standard\n<\/target_standard>/);
  assert.equal(run.prompts.match(/The Output Format of the persona does not apply/g)?.length, 7);
  assert.equal(run.report?.commit, '', 'outside a git repository, no commit is recorded');
  assert.deepEqual({ status: run.report?.status, blockers: run.report?.blockers }, { status: 'clean', blockers: 0 });
});

test('flow-review: a Blocker stops the run in "waiting" with the question, and the answer resumes it from check', { skip: !available }, () => {
  const root = project();
  const first = awf(root, ['run', 'flow-review', '--input', 'change=demo'], { FAKE_FINDINGS: BLOCKER });

  assert.notEqual(first.status, 0);
  assert.match(first.output, /To answer: .*awf resume \S+ --from check --input egm_decision=<answer>/);
  assert.equal(first.report?.status, 'waiting');
  assert.equal(first.report?.blockers, 7);
  assert.match(first.review, /## Blocker\n\n- \*\*proposal\.md:1\*\* \(zoom-out\): The proposal does not say why\.\n {2}Recommendation: Add the motivation\./);
  rmSync(join(root, 'claude.log'));

  const resumed = awf(root, ['resume', String(first.report?.run), '--from', 'check', '--input', 'egm_decision=proceed']);
  assert.equal(resumed.status, 0, resumed.output);
  assert.equal(resumed.report?.status, 'accepted');
  assert.equal(resumed.prompts, '', 'no reviewer runs again on resume');
});

test('flow-review: in the default silent output, "waiting" still prints the question and the resume line', { skip: !available }, () => {
  const run = awf(project(), ['run', 'flow-review', '--input', 'change=demo'], { FAKE_FINDINGS: BLOCKER }, 'silent');

  assert.equal(run.status, 3);
  assert.match(run.output, /Question \(decision\): The EGM review of demo found 7 Blocker/);
  assert.match(run.output, /To answer: AWF_WORKFLOWS_PATH=\S+ awf resume \S+ --from check --input egm_decision=<answer>/);
});

test('flow-review: "revise" ends in "declined" and records the decision', { skip: !available }, () => {
  const root = project();
  const first = awf(root, ['run', 'flow-review', '--input', 'change=demo'], { FAKE_FINDINGS: BLOCKER });
  const resumed = awf(root, ['resume', String(first.report?.run), '--from', 'check', '--input', 'egm_decision=revise']);

  assert.notEqual(resumed.status, 0);
  assert.match(resumed.output, /terminal failure state: declined/);
  assert.equal(resumed.report?.status, 'revise');
});

test('flow-review: a reviewer answer that is not a findings object fails the run', { skip: !available }, () => {
  const run = awf(project(), ['run', 'flow-review', '--input', 'change=demo'], { FAKE_FINDINGS: '{"verdict":"fine"}' });

  assert.notEqual(run.status, 0);
  assert.match(run.output, /returned no valid findings/);
});

test('flow-review: a reviewer answer with text around the JSON object is saved', { skip: !available }, () => {
  const root = project();
  const run = awf(root, ['run', 'flow-review', '--input', 'change=demo'], { FAKE_FINDINGS: `I read the plan and the code.\n\n${BLOCKER}\n\nThat is all.` });

  assert.equal(run.report?.blockers, 7, run.output);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.awf/status/egm/codebase-details.json'), 'utf8')), JSON.parse(BLOCKER));

  const fenced = awf(project(), ['run', 'flow-review', '--input', 'change=demo'], { FAKE_FINDINGS: `Here is my review.\n\n\`\`\`json\n${BLOCKER}\n\`\`\`` });
  assert.equal(fenced.report?.blockers, 7, fenced.output);
});

test('flow-review: a failed reviewer leaves its error in <reviewer>.err and names that file', { skip: !available }, () => {
  const root = project();
  const run = awf(root, ['run', 'flow-review', '--input', 'change=demo'], { FAKE_STDERR: 'Prompt is too long' }, 'silent');
  const err = join(root, '.awf/status/egm/zoom-out.err');

  assert.notEqual(run.status, 0);
  assert.match(run.output, /\.awf\/status\/egm\/zoom-out\.err/);
  assert.ok(existsSync(err), run.output);
  assert.match(readFileSync(err, 'utf8'), /^status: failed\n/, 'awf passes on neither the stderr nor the exit code of an agent step: the status marks the failure');
});

test('egm-review.sh save: an answer that is not a findings object goes to <reviewer>.err, not to <reviewer>.json', () => {
  const root = project();
  const run = spawnSync('bash', [SCRIPT, 'save', 'style', 'completed'], { cwd: root, encoding: 'utf8', input: 'I could not finish the review.\n', env: env(root) });

  assert.equal(run.status, 30);
  assert.match(run.stderr, /\.awf\/status\/egm\/style\.err/);
  assert.ok(!existsSync(join(root, '.awf/status/egm/style.json')));
  assert.match(readFileSync(join(root, '.awf/status/egm/style.err'), 'utf8'), /I could not finish the review\./);
});

test('egm-review.sh init: exit 2 without EGM, naming how to install it', () => {
  const root = project();
  const run = spawnSync('bash', [SCRIPT, 'init', 'demo'], { cwd: root, encoding: 'utf8', env: { ...process.env, EGM_ROOT: join(root, 'absent') } });

  assert.equal(run.status, 2);
  assert.match(run.stderr, /claude plugin install egm@egm/);
});

test('egm-review.sh init: exit 2 for a change that is not here', () => {
  assert.equal(script(project(), 'init', 'other').status, 2);
  assert.equal(script(project(), 'init', 'Bad_Name').status, 2);
});

test('egm-review.sh decide: only none, proceed, revise and abandon', () => {
  const root = project();
  for (const decision of ['none', 'proceed', 'revise', 'abandon']) assert.equal(script(root, 'decide', decision).stdout, decision);
  assert.equal(script(root, 'decide', 'maybe').status, 2);
});

test('egm-review.sh brief: the feature reviewers do not read tasks.md, the plan reviewers do', () => {
  const root = project();
  const design = script(root, 'brief', 'demo', 'design').stdout;
  const plan = script(root, 'brief', 'demo', 'implementation-readiness').stdout;

  assert.match(design, /proposal\.md/);
  assert.match(design, /specs\/cap\/spec\.md/);
  assert.doesNotMatch(design, /- .*tasks\.md/);
  assert.match(plan, /- openspec\/changes\/demo\/tasks\.md/);
  assert.match(plan, /design\.md \(context only\)/);
  assert.equal(script(root, 'brief', 'demo', 'unknown').status, 2);
});

test('egm-review.sh root: the highest installed version of the plugin cache', () => {
  const root = project();
  for (const version of ['0.1.0', '0.10.0', '0.9.2']) mkdirSync(join(root, 'cfg', 'plugins', 'cache', 'egm', 'egm', version, 'agents'), { recursive: true });
  const run = spawnSync('bash', [SCRIPT, 'root'], { cwd: root, encoding: 'utf8', env: { ...process.env, EGM_ROOT: '', CLAUDE_CONFIG_DIR: join(root, 'cfg') } });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.trim(), /\/0\.10\.0$/);
});
