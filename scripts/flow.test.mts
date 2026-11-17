// flow.sh: unit subcommands, tried on a throwaway git repository. No agent runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The tests also run inside an agent step, whose session is not "attended": it is forced here.
// The run mode (NEXUS_AGENT_RUN_ID) is off unless a test sets it, even when the suite itself runs in a Susan run.
const ATTENDED: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_SESSION_ATTENDED: '1' };
delete ATTENDED.NEXUS_AGENT_RUN_ID;
const RUN = { NEXUS_AGENT_RUN_ID: 'run-1' };
const FLOW = join(dirname(fileURLToPath(import.meta.url)), 'flow.sh');
const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  return run.stdout.trim();
}

// Throwaway repository with an "existing" change on main.
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'flow-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'openspec/changes/existing'), { recursive: true });
  writeFileSync(join(root, 'openspec/changes/existing/proposal.md'), '# existing\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

// Adds to main the language registry, whose checks the pack's merge gate reads, for the `merge` tests.
function withGate(root: string): string {
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf/languages.yaml'), 'php:\n  dir: api\n  merge_checks:\n    phpstan: \'false\'\n    psalm: \'false\'\n    unit: \'false\'\n    functional: \'false\'\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'gate');
  return root;
}

function flow(root: string, ...args: string[]) {
  const run = spawnSync('bash', [FLOW, ...args], { cwd: root, encoding: 'utf8', env: ATTENDED });
  return { code: run.status, out: run.stdout + run.stderr };
}

test('init exits 2 for a name that is not in kebab-case', () => {
  const root = project();
  const run = flow(root, 'init', 'propose', 'My_Feature');
  assert.equal(run.code, 2);
  assert.match(run.out, /change/);
  assert.match(run.out, /My_Feature/);
  assert.equal(existsSync(join(root, '.worktrees')), false);
});

test('init exits 2 for an unknown command', () => {
  assert.equal(flow(project(), 'init', 'dance', 'my-feature').code, 2);
});

test('init propose exits 2 for an existing change and points to /flow:update', () => {
  const run = flow(project(), 'init', 'propose', 'existing');
  assert.equal(run.code, 2);
  assert.match(run.out, /\/flow:update/);
});

test('init update exits 2 for an unknown change and lists the available changes', () => {
  const run = flow(project(), 'init', 'update', 'unknown');
  assert.equal(run.code, 2);
  assert.match(run.out, /existing/);
});

test('init sync exits 2 for an unknown change', () => {
  assert.equal(flow(project(), 'init', 'sync', 'unknown').code, 2);
});

test('init propose creates the worktree on branch docs/propose-<change>', () => {
  const root = project();
  const run = flow(root, 'init', 'propose', 'my-feature');
  assert.equal(run.code, 0, run.out);
  assert.ok(existsSync(join(root, '.worktrees/propose-my-feature/.git')));
  assert.equal(git(join(root, '.worktrees/propose-my-feature'), 'branch', '--show-current'), 'docs/propose-my-feature');
});

test('init reuses an existing worktree without creating it again', () => {
  const root = project();
  assert.equal(flow(root, 'init', 'propose', 'my-feature').code, 0);
  writeFileSync(join(root, '.worktrees/propose-my-feature/marker'), 'x');
  const run = flow(root, 'init', 'propose', 'my-feature');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /reused/);
  assert.ok(existsSync(join(root, '.worktrees/propose-my-feature/marker')));
});

test('init update creates the worktree of a change present on main', () => {
  const root = project();
  const run = flow(root, 'init', 'update', 'existing');
  assert.equal(run.code, 0, run.out);
  assert.equal(git(join(root, '.worktrees/propose-existing'), 'branch', '--show-current'), 'docs/propose-existing');
});

test('init update accepts a change present only in the proposal worktree', () => {
  const root = project();
  assert.equal(flow(root, 'init', 'propose', 'fresh').code, 0);
  mkdirSync(join(root, '.worktrees/propose-fresh/openspec/changes/fresh'), { recursive: true });
  writeFileSync(join(root, '.worktrees/propose-fresh/openspec/changes/fresh/proposal.md'), '# fresh\n');
  assert.equal(flow(root, 'init', 'update', 'fresh').code, 0);
});

// Throwaway worktree: files are written in it and the gate runs in its directory.
function flowEnv(root: string, env: Record<string, string>, ...args: string[]) {
  const run = spawnSync('bash', [FLOW, ...args], { cwd: root, encoding: 'utf8', env: { ...ATTENDED, ...env } });
  return { code: run.status, stdout: run.stdout, out: run.stdout + run.stderr };
}

test('init-agent exits 2 when the name or the task is not in kebab-case, and creates nothing', () => {
  const root = project();
  for (const args of [['Reviewer', 'fix-login'], ['reviewer', 'fix_login'], ['reviewer', '']]) {
    assert.equal(flow(root, 'init-agent', ...args).code, 2, args.join(' '));
  }
  assert.equal(existsSync(join(root, '.worktrees')), false);
});

test('init-agent creates .worktrees/<name>-<task> on branch agent/<name>-<task> and writes its report', () => {
  const root = project();
  const run = flowEnv(root, {}, 'init-agent', 'reviewer', 'fix-login');
  const tree = join(root, '.worktrees/reviewer-fix-login');
  assert.equal(run.code, 0, run.out);
  assert.equal(run.stdout, `Worktree created: ${tree}\n`);
  assert.equal(git(tree, 'branch', '--show-current'), 'agent/reviewer-fix-login');
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.awf/status/agent-worktree/reviewer-fix-login.json'), 'utf8')), {
    name: 'reviewer', task: 'fix-login', branch: 'agent/reviewer-fix-login', worktree: tree,
  });
});

test('init-agent run from a worktree still places the agent worktree in the main worktree', () => {
  const root = project();
  flow(root, 'init-agent', 'a', 'one');
  const run = flowEnv(join(root, '.worktrees/a-one'), {}, 'init-agent', 'b', 'two');
  assert.equal(run.stdout, `Worktree created: ${join(root, '.worktrees/b-two')}\n`);
});

test('init-agent reuses a clean worktree, refuses one with changes unless AGENT_REPRISE=1', () => {
  const root = project();
  flow(root, 'init-agent', 'reviewer', 'fix-login');
  const tree = join(root, '.worktrees/reviewer-fix-login');
  assert.equal(flowEnv(root, {}, 'init-agent', 'reviewer', 'fix-login').stdout, `Worktree reused: ${tree}\n`);
  writeFileSync(join(tree, 'untracked.txt'), 'x');
  const refused = flow(root, 'init-agent', 'reviewer', 'fix-login');
  assert.equal(refused.code, 2);
  assert.match(refused.out, /reviewer-fix-login has uncommitted changes/);
  assert.match(refused.out, /AGENT_REPRISE=1/);
  const resumed = flowEnv(root, { AGENT_REPRISE: '1' }, 'init-agent', 'reviewer', 'fix-login');
  assert.equal(resumed.code, 0);
  assert.equal(resumed.stdout, `Worktree reused: ${tree}\n`);
});

test('init-agent checks out an existing branch, and exits 2 when the base branch is missing', () => {
  const root = project();
  git(root, 'branch', 'agent/reviewer-fix-login');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'later');
  const run = flow(root, 'init-agent', 'reviewer', 'fix-login');
  assert.equal(run.code, 0, run.out);
  assert.equal(git(join(root, '.worktrees/reviewer-fix-login'), 'log', '-1', '--format=%s'), 'init');
  assert.equal(flowEnv(root, { BASE_BRANCH: 'nope' }, 'init-agent', 'other', 'task').code, 2);
});

test('init-agent links the packs installed in the main worktree into the new worktree', () => {
  const root = project();
  mkdirSync(join(root, '.awf/workflow-packs/openspec-tdd'), { recursive: true });
  writeFileSync(join(root, '.git/info/exclude'), '/.awf/workflow-packs\n');
  flow(root, 'init-agent', 'reviewer', 'fix-login');
  const tree = join(root, '.worktrees/reviewer-fix-login');
  assert.ok(existsSync(join(tree, '.awf/workflow-packs/openspec-tdd')));
  assert.equal(git(tree, 'status', '--porcelain'), '');
});

function dirty(root: string, ...files: string[]): void {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'x');
  }
}

test('gate scope update accepts the files of the change and returns 0', () => {
  const root = project();
  dirty(root, 'openspec/changes/my-feature/proposal.md', 'openspec/changes/my-feature/specs/a/spec.md');
  assert.equal(flow(root, 'gate', 'scope', 'update', 'my-feature').code, 0);
});

test('gate scope propose accepts a worktree without changes', () => {
  assert.equal(flow(project(), 'gate', 'scope', 'propose', 'my-feature').code, 0);
});

test('gate scope update rejects a file outside the change, names it and returns 30', () => {
  const root = project();
  dirty(root, 'openspec/changes/my-feature/proposal.md', 'api/src/Foo.php');
  const run = flow(root, 'gate', 'scope', 'update', 'my-feature');
  assert.equal(run.code, 30);
  assert.match(run.out, /api\/src\/Foo\.php/);
});

test('gate scope update rejects the directory of another change', () => {
  const root = project();
  dirty(root, 'openspec/changes/existing/proposal.md');
  assert.equal(flow(root, 'gate', 'scope', 'update', 'my-feature').code, 30);
});

test('gate scope update rejects a directory whose name extends the change name', () => {
  const root = project();
  dirty(root, 'openspec/changes/my-feature-bis/proposal.md');
  assert.equal(flow(root, 'gate', 'scope', 'update', 'my-feature').code, 30);
});

test('gate scope sync accepts openspec/specs and rejects a change', () => {
  const root = project();
  dirty(root, 'openspec/specs/cap/spec.md');
  assert.equal(flow(root, 'gate', 'scope', 'sync', 'my-feature').code, 0);
  dirty(root, 'openspec/changes/my-feature/proposal.md');
  assert.equal(flow(root, 'gate', 'scope', 'sync', 'my-feature').code, 30);
});

test('gate scope rejects a changed tracked file and a deleted file', () => {
  const root = project();
  writeFileSync(join(root, 'openspec/changes/existing/proposal.md'), 'changed\n');
  assert.equal(flow(root, 'gate', 'scope', 'update', 'my-feature').code, 30);
});

test('gate scope exits 2 for an unknown command', () => {
  assert.equal(flow(project(), 'gate', 'scope', 'dance', 'my-feature').code, 2);
});

test('gate scope exits 2 for a change that is not in kebab-case', () => {
  assert.equal(flow(project(), 'gate', 'scope', 'update', 'My_Feature').code, 2);
});

test('gate explore returns 0 when openspec/ is untouched, even if the rest changes', () => {
  const root = project();
  dirty(root, 'notes.txt');
  assert.equal(flow(root, 'gate', 'explore').code, 0);
});

test('gate explore returns 30 and names the changed file under openspec/', () => {
  const root = project();
  dirty(root, 'openspec/changes/fresh/proposal.md');
  const run = flow(root, 'gate', 'explore');
  assert.equal(run.code, 30);
  assert.match(run.out, /openspec\/changes\/fresh\/proposal\.md/);
});

test('gate exits 2 for an unknown gate', () => {
  assert.equal(flow(project(), 'gate', 'dance').code, 2);
});

// commit: the workflow commits, the agent never does.
function lastMessage(root: string): string {
  return git(root, 'log', '-1', '--format=%B');
}

test('commit propose writes its message, with no trailer and no tool mention', () => {
  const root = project();
  dirty(root, 'openspec/changes/my-feature/proposal.md');
  const run = flow(root, 'commit', 'propose', 'my-feature');
  assert.equal(run.code, 0, run.out);
  assert.equal(lastMessage(root).trim(), 'docs(openspec): propose change my-feature');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('commit update and sync each have their message', () => {
  const root = project();
  dirty(root, 'openspec/changes/existing/a.md');
  assert.equal(flow(root, 'commit', 'update', 'existing').code, 0);
  assert.equal(lastMessage(root).trim(), 'docs(openspec): update change existing');
  dirty(root, 'openspec/specs/cap/spec.md');
  assert.equal(flow(root, 'commit', 'sync', 'existing').code, 0);
  assert.equal(lastMessage(root).trim(), 'docs(openspec): sync the specs of change existing');
});

test('commit archive has its message', () => {
  const root = project();
  dirty(root, 'openspec/changes/archive/existing/proposal.md');
  assert.equal(flow(root, 'commit', 'archive', 'existing').code, 0);
  assert.equal(lastMessage(root).trim(), 'docs(openspec): archive change existing');
});

test('commit adds no tool trailer', () => {
  const root = project();
  dirty(root, 'openspec/changes/my-feature/proposal.md');
  flow(root, 'commit', 'propose', 'my-feature');
  assert.doesNotMatch(lastMessage(root), /Co-Authored-By|Claude|agent|session|Generated/i);
});

test('commit without changes returns 0 and creates no commit', () => {
  const root = project();
  const before = git(root, 'rev-parse', 'HEAD');
  const run = flow(root, 'commit', 'propose', 'my-feature');
  assert.equal(run.code, 0, run.out);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
});

test('commit exits 2 for an invalid command or change', () => {
  const root = project();
  assert.equal(flow(root, 'commit', 'dance', 'my-feature').code, 2);
  assert.equal(flow(root, 'commit', 'propose', 'My_Feature').code, 2);
});

// report: JSON report and exit code per phase.
function report(root: string, command: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, `.awf/status/flow-${command}.json`), 'utf8'));
}

test('report writes command, change, phase, attempts, waived gates and status', () => {
  const root = project();
  const run = flow(root, 'report', 'update', 'my-feature', 'done', '2', 'success', 'dod', 'deltas');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(report(root, 'update'), {
    command: 'update',
    change: 'my-feature',
    phase: 'done',
    attempts: 2,
    waived: ['dod', 'deltas'],
    status: 'success',
  });
});

test('a gate failure report writes phase gate, 3 attempts, status failed, and returns 30', () => {
  const root = project();
  const run = flow(root, 'report', 'propose', 'my-feature', 'gate', '3', 'failed');
  assert.equal(run.code, 30);
  const json = report(root, 'propose');
  assert.equal(json.phase, 'gate');
  assert.equal(json.attempts, 3);
  assert.equal(json.status, 'failed');
  assert.deepEqual(json.waived, []);
});

test('report returns 2 for a failed input and 3 for a failed agent', () => {
  const root = project();
  assert.equal(flow(root, 'report', 'sync', 'my-feature', 'input', '0', 'failed').code, 2);
  assert.equal(flow(root, 'report', 'sync', 'my-feature', 'agent', '1', 'failed').code, 3);
  assert.equal(report(root, 'sync').phase, 'agent');
});

test('report exits 2 for invalid arguments and writes no report', () => {
  const root = project();
  assert.equal(flow(root, 'report', 'dance', 'my-feature', 'gate', '1', 'failed').code, 2);
  assert.equal(flow(root, 'report', 'update', 'My_Feature', 'gate', '1', 'failed').code, 2);
  assert.equal(flow(root, 'report', 'update', 'my-feature', 'elsewhere', '1', 'failed').code, 2);
  assert.equal(flow(root, 'report', 'update', 'my-feature', 'gate', 'x', 'failed').code, 2);
  assert.equal(flow(root, 'report', 'update', 'my-feature', 'gate', '1', 'meh').code, 2);
  assert.equal(flow(root, 'report', 'update', 'my-feature', 'commit', '1', 'failed').code, 2);
  assert.equal(existsSync(join(root, '.awf/status')), false);
});

// flow-gate and flow-commit: the five drafting workflows call them through call_workflow.
const WORKFLOWS = join(dirname(FLOW), '..', 'workflows');
const DRAFTING = ['propose', 'update', 'sync', 'archive', 'accept'];
const GATES = ['scope', 'validation', 'deltas', 'dod', 'manual', 'levels', 'waivers'];

for (const name of DRAFTING) {
  test(`flow-${name} calls flow-gate and flow-commit through call_workflow`, () => {
    const text = readFileSync(join(WORKFLOWS, `flow-${name}.yaml`), 'utf8');
    for (const called of ['flow-gate', 'flow-commit']) {
      assert.match(text, new RegExp(`type:\\s*call_workflow\\s*\\n(?:\\s+\\w+:.*\\n)*?\\s+workflow:\\s*${called}\\s*$`, 'm'), `${name} must call ${called}`);
    }
  });
}

// propose, update and sync share one shape, repeated in each YAML file (awf has no inheritance).
const DRAFTING_SHAPE = ['init', 'agent', 'gate_loop', 'commit', 'report'];
const SKILLS: Record<string, string> = {
  propose: 'openspec-writer, openspec-propose',
  update: 'openspec-writer, openspec-update-change',
  sync: 'specs-synchronizer, openspec-sync-specs',
};

for (const [name, skills] of Object.entries(SKILLS)) {
  test(`flow-${name} follows the drafting shape and declares its skills`, () => {
    const text = readFileSync(join(WORKFLOWS, `flow-${name}.yaml`), 'utf8');
    const states = [...(text.split(/^states:\s*$/m)[1] ?? '').matchAll(/^ {2}([a-z_]+):\s*$/gm)].map((m) => m[1]);
    const positions = DRAFTING_SHAPE.map((state) => states.indexOf(state));
    assert.ok(positions.every((p) => p >= 0), `missing states: ${DRAFTING_SHAPE.filter((_, i) => positions[i] < 0).join(', ')}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the states of the drafting shape are out of order');
    const entries = skills.split(', ').map((skill) => `\\n {6}- path: \\.\\./skills/${skill}`).join('');
    assert.match(text, new RegExp(`skills:${entries}\\n`), `expected skills: ${skills}`);
    assert.match(text, /prompt_file:.*flow-agent\.md/);
    assert.match(text, /prompt_file:.*flow-fix\.md/);
  });
}

const block = (text: string, state: string) => text.split(new RegExp(`^  ${state}:\\s*$`, 'm'))[1]?.split(/^  \w+:\s*$/m)[0] ?? '';

// The purge of pass proofs follows the commit, and its exit code does not change the outcome of the archive.
test('flow-archive purges the proofs after the commit, and reaches the success report whether the purge succeeds or not', () => {
  const text = readFileSync(join(WORKFLOWS, 'flow-archive.yaml'), 'utf8');
  assert.match(block(text, 'commit'), /^ {4}on_success: purge$/m);
  assert.match(block(text, 'purge'), /^ {4}command: bash \{\{\.awf\.scripts_dir\}\}\/tdd-gate\.sh proofs purge$/m);
  assert.match(block(text, 'purge'), /^ {4}on_success: report$/m);
  assert.match(block(text, 'purge'), /^ {4}on_failure: report$/m);
});

// The dependencies are installed after the open boxes are rejected and before any replay.
test('flow-archive installs the dependencies between open_boxes and replay, and exits through report_gate (code 30) on failure', () => {
  const text = readFileSync(join(WORKFLOWS, 'flow-archive.yaml'), 'utf8');
  assert.match(block(text, 'open_boxes'), /^ {4}on_success: dependencies$/m);
  assert.match(block(text, 'dependencies'), /^ {4}command: bash \{\{\.awf\.scripts_dir\}\}\/commands\.sh deps \.$/m);
  assert.match(block(text, 'dependencies'), /^ {4}on_success: replay$/m);
  assert.match(block(text, 'dependencies'), /^ {4}on_failure: report_gate$/m);
  assert.match(block(text, 'report_gate'), /status: 30/);
});

test('flow-gate has one state per gate, each calling flow.sh', () => {
  const text = readFileSync(join(WORKFLOWS, 'flow-gate.yaml'), 'utf8');
  for (const gate of GATES) assert.match(block(text, gate), /flow\.sh/, `state ${gate} must call flow.sh`);
});

test('gate manual returns 30 for a manual task with neither a "Verified by" command nor "Manual", 0 once it has one', () => {
  const root = project();
  const tasks = join(root, 'openspec/changes/existing/tasks.md');
  writeFileSync(tasks, '## 1. Docs\n\n- [ ] 1.1 [docs] Rewrite the README, vérifier par une relecture\n');
  const run = flow(root, 'gate', 'manual', 'existing');
  assert.equal(run.code, 30);
  assert.match(run.out, /1\.1/);
  writeFileSync(tasks, '## 1. Docs\n\n- [ ] 1.1 [docs] Rewrite the README. Vérifié par : `test -f README.md`\n');
  assert.equal(flow(root, 'gate', 'manual', 'existing').code, 0);
});

test('gate levels returns 30 for a slice without a test level when its language declares levels, 0 once it has one', () => {
  const root = project();
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf/languages.yaml'), "php:\n  workflow: tdd-slice-php\n  levels:\n    unit: '^api/tests/Unit/'\n");
  const tasks = join(root, 'openspec/changes/existing/tasks.md');
  writeFileSync(tasks, '## 1. Orders\n\n- [ ] 1.1 Total\n  - [ ] 1.1.1 [php] The total sums the lines\n');
  const run = flow(root, 'gate', 'levels', 'existing');
  assert.equal(run.code, 30);
  assert.match(run.out, /1\.1\.1/);
  writeFileSync(tasks, '## 1. Orders\n\n- [ ] 1.1 Total\n  - [ ] 1.1.1 [php] [unit] The total sums the lines\n');
  assert.equal(flow(root, 'gate', 'levels', 'existing').code, 0);
});

test('flow-gate runs the levels gate for propose and update only', () => {
  const levels = block(readFileSync(join(WORKFLOWS, 'flow-gate.yaml'), 'utf8'), 'levels');
  assert.match(levels, /case '\{\{\.inputs\.command\}\}' in propose\|update\) ;; \*\) exit 0 ;; esac/);
});

test('flow-gate runs the manual gate for propose and update only', () => {
  const manual = block(readFileSync(join(WORKFLOWS, 'flow-gate.yaml'), 'utf8'), 'manual');
  assert.match(manual, /case '\{\{\.inputs\.command\}\}' in propose\|update\) ;; \*\) exit 0 ;; esac/);
});

test('gate deltas returns 0 without a delta and 30 with a requirement that is too long', () => {
  const root = project();
  assert.equal(flow(root, 'gate', 'deltas', 'existing').code, 0);
  mkdirSync(join(root, 'openspec/changes/existing/specs/cap'), { recursive: true });
  writeFileSync(
    join(root, 'openspec/changes/existing/specs/cap/spec.md'),
    `## ADDED Requirements\n\n### Requirement: Long\nThe system SHALL ${'x'.repeat(600)}.\n\n#### Scenario: S\n- **WHEN** a\n- **THEN** b\n`,
  );
  assert.equal(flow(root, 'gate', 'deltas', 'existing').code, 30);
});

// waive: registry and log under <git-common-dir>/awf/.
function dayPlus(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

function projectWithAuthor(): string {
  const root = project();
  git(root, 'config', 'user.name', 'Alice Test');
  return root;
}

const registry = (root: string) => join(root, '.git/awf/waivers.yaml');
const log = (root: string) => join(root, '.git/awf/waivers.log');

test('waive writes a registry line with change, gate, reason, author, grant date and expiry at 30 days', () => {
  const root = projectWithAuthor();
  const run = flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'slow test under load');
  assert.equal(run.code, 0, run.out);
  const line = readFileSync(registry(root), 'utf8').trim();
  assert.match(line, /change: my-feature/);
  assert.match(line, /gate: review-ts/);
  assert.match(line, /reason: "slow test under load"/);
  assert.match(line, /author: "Alice Test"/);
  assert.match(line, new RegExp(`granted: ${dayPlus(0)}`));
  assert.match(line, new RegExp(`expires: ${dayPlus(30)}`));
});

test('waive without a reason or with an empty reason returns 2, asks for the reason and writes nothing', () => {
  const root = projectWithAuthor();
  for (const args of [[], ['--reason', ''], ['--reason', '  ']]) {
    const run = flow(root, 'waive', 'my-feature', 'review-ts', ...args);
    assert.equal(run.code, 2);
    assert.match(run.out, /--reason/);
  }
  assert.equal(existsSync(registry(root)), false);
  assert.equal(existsSync(log(root)), false);
});

test('waive --days shortens the duration', () => {
  const root = projectWithAuthor();
  assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x', '--days', '7').code, 0);
  assert.match(readFileSync(registry(root), 'utf8'), new RegExp(`expires: ${dayPlus(7)}`));
});

test('waive --days 45 returns 2, names the 30-day maximum and writes nothing', () => {
  const root = projectWithAuthor();
  const run = flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x', '--days', '45');
  assert.equal(run.code, 2);
  assert.match(run.out, /30 days/);
  assert.equal(existsSync(registry(root)), false);
});

test('waive exits 2 for --days zero, negative or not an integer', () => {
  const root = projectWithAuthor();
  for (const days of ['0', '-3', 'abc', '2.5']) {
    assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x', '--days', days).code, 2, days);
  }
  assert.equal(existsSync(registry(root)), false);
});

test('waive exits 2 for an invalid change or gate, an unknown argument and a reason on several lines', () => {
  const root = projectWithAuthor();
  assert.equal(flow(root, 'waive', 'My_Feature', 'review-ts', '--reason', 'x').code, 2);
  assert.equal(flow(root, 'waive', 'my-feature', 'Review TS', '--reason', 'x').code, 2);
  assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x', '--force').code, 2);
  assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'a\nb').code, 2);
  assert.equal(existsSync(registry(root)), false);
});

test('waive exits 2 without a git author', () => {
  const root = project();
  const run = spawnSync('bash', [FLOW, 'waive', 'my-feature', 'review-ts', '--reason', 'x'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ATTENDED: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /user\.name/);
  assert.equal(existsSync(registry(root)), false);
});

test('waive escapes the quotes and backslashes of the reason in the registry', () => {
  const root = projectWithAuthor();
  assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'says "yes" \\ no').code, 0);
  assert.match(readFileSync(registry(root), 'utf8'), /reason: "says \\"yes\\" \\\\ no"/);
});

test('waive logs the grant and appends without losing a line', () => {
  const root = projectWithAuthor();
  flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'one');
  flow(root, 'waive', 'other', 'review-php', '--reason', 'two');
  const lines = readFileSync(log(root), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z grant my-feature review-ts Alice Test/);
  assert.match(lines[1], / grant other review-php /);
  assert.equal(readFileSync(registry(root), 'utf8').trim().split('\n').length, 2);
});

test('shared registry: the main worktree and a worktree read the same registry, git status stays empty', () => {
  const root = projectWithAuthor();
  const tree = `${root}-w`;
  roots.push(tree);
  git(root, 'worktree', 'add', '-q', '-b', 'b', tree);
  assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x').code, 0);
  assert.equal(flow(tree, 'waived', 'my-feature', 'review-ts').code, 0);
  assert.equal(flow(tree, 'waive', 'other', 'review-php', '--reason', 'y').code, 0);
  assert.equal(flow(root, 'waived', 'other', 'review-php').code, 0);
  assert.equal(readFileSync(registry(root), 'utf8').trim().split('\n').length, 2);
  assert.equal(existsSync(join(tree, '.awf')), false);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.match(flow(tree, 'context').out, /Valid waivers:\n {2}- \{change: my-feature/);
});

test('migrate copies both tracked files without losing a line, removes them from git, and returns 0 with nothing to migrate', () => {
  const root = projectWithAuthor();
  assert.equal(flow(root, 'migrate').code, 0);
  assert.equal(existsSync(registry(root)), false);
  assert.equal(flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x').code, 0);
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf/waivers.yaml'), '- old line\n- other line\n');
  writeFileSync(join(root, '.awf/waivers.log'), 'old grant\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'tracked registry');
  assert.equal(flow(root, 'migrate').code, 0);
  const lines = readFileSync(registry(root), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(-2), ['- old line', '- other line']);
  assert.match(readFileSync(log(root), 'utf8'), /old grant\n$/);
  assert.equal(existsSync(join(root, '.awf/waivers.yaml')), false);
  assert.equal(git(root, 'ls-files', '.awf'), '');
  assert.equal(flow(root, 'migrate').code, 0);
  assert.equal(readFileSync(registry(root), 'utf8').trim().split('\n').length, 3);
});

// waived: a failed gate passes when a valid waiver exists.
function writeRegistry(root: string, change: string, gate: string, expires: string): void {
  mkdirSync(join(root, '.git/awf'), { recursive: true });
  writeFileSync(
    registry(root),
    `- {change: ${change}, gate: ${gate}, reason: "reason", author: "Alice Test", granted: 2026-01-01, expires: ${expires}}\n`,
  );
}

test('waived returns 0 for a valid waiver, says the gate is waived and logs the use', () => {
  const root = projectWithAuthor();
  flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x');
  const run = flow(root, 'waived', 'my-feature', 'review-ts');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /waived/);
  const lines = readFileSync(log(root), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z use my-feature review-ts Alice Test/);
});

test('waived accepts a waiver that expires today', () => {
  const root = projectWithAuthor();
  writeRegistry(root, 'my-feature', 'review-ts', dayPlus(0));
  assert.equal(flow(root, 'waived', 'my-feature', 'review-ts').code, 0);
});

test('waived returns 30 for an expired waiver, without logging a use', () => {
  const root = projectWithAuthor();
  writeRegistry(root, 'my-feature', 'review-ts', dayPlus(-1));
  const run = flow(root, 'waived', 'my-feature', 'review-ts');
  assert.equal(run.code, 30);
  assert.match(run.out, /expired/);
  assert.equal(existsSync(log(root)), false);
});

test('waived returns 30 without a registry, for another change or another gate', () => {
  const root = projectWithAuthor();
  assert.equal(flow(root, 'waived', 'my-feature', 'review-ts').code, 30);
  writeRegistry(root, 'my-feature', 'review-ts', dayPlus(5));
  assert.equal(flow(root, 'waived', 'other', 'review-ts').code, 30);
  assert.equal(flow(root, 'waived', 'my-feature', 'review-php').code, 30);
  assert.equal(flow(root, 'waived', 'my-feature', 'review').code, 30);
  assert.equal(existsSync(log(root)), false);
});

test('waived is not fooled by a reason that imitates a registry line', () => {
  const root = projectWithAuthor();
  flow(root, 'waive', 'my-feature', 'review-ts', '--reason', ', change: other, gate: review-php, reason: "x", expires: 2999-01-01}');
  assert.equal(flow(root, 'waived', 'other', 'review-php').code, 30);
});

test('waived exits 2 for an invalid change or gate', () => {
  const root = projectWithAuthor();
  assert.equal(flow(root, 'waived', 'My_Feature', 'review-ts').code, 2);
  assert.equal(flow(root, 'waived', 'my-feature', 'Review TS').code, 2);
});

// fingerprint: the registry and the log do not change during an agent step.
test('fingerprint check returns 0 when the registry and the log did not change during the step', () => {
  const root = projectWithAuthor();
  flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x');
  assert.equal(flow(root, 'fingerprint', 'save').code, 0);
  assert.equal(flow(root, 'fingerprint', 'check').code, 0);
});

test('fingerprint check returns 0 when the registry exists neither before nor after', () => {
  const root = projectWithAuthor();
  flow(root, 'fingerprint', 'save');
  assert.equal(flow(root, 'fingerprint', 'check').code, 0);
});

test('fingerprint check returns 30 and names the registry that an agent changed', () => {
  const root = projectWithAuthor();
  flow(root, 'waive', 'my-feature', 'review-ts', '--reason', 'x');
  flow(root, 'fingerprint', 'save');
  writeRegistry(root, 'my-feature', 'review-php', dayPlus(30));
  const run = flow(root, 'fingerprint', 'check');
  assert.equal(run.code, 30);
  assert.match(run.out, /awf\/waivers\.yaml/);
  assert.doesNotMatch(run.out, /waivers\.log/);
});

test('fingerprint check returns 30 when an agent creates the registry or deletes the log', () => {
  const root = projectWithAuthor();
  flow(root, 'fingerprint', 'save');
  writeRegistry(root, 'my-feature', 'review-ts', dayPlus(30));
  assert.equal(flow(root, 'fingerprint', 'check').code, 30);

  flow(root, 'waive', 'a', 'b', '--reason', 'x');
  flow(root, 'fingerprint', 'save');
  rmSync(log(root));
  const run = flow(root, 'fingerprint', 'check');
  assert.equal(run.code, 30);
  assert.match(run.out, /awf\/waivers\.log/);
});

test('fingerprint check without a recorded fingerprint returns 2', () => {
  assert.equal(flow(projectWithAuthor(), 'fingerprint', 'check').code, 2);
});

// flow-archive and flow-accept: an open box stops the run (2), a command that fails on replay too (30).
function changeWithDod(root: string, change: string, criteria: string, tasks = '- [x] 1.1 Done.\n'): void {
  mkdirSync(join(root, 'openspec/changes', change), { recursive: true });
  writeFileSync(join(root, 'openspec/changes', change, 'tasks.md'), `# Tasks\n\n## Definition of Done\n\n${criteria}\n## 1. Group\n\n${tasks}`);
}

test('gate open returns 0 when every box is checked', () => {
  const root = project();
  changeWithDod(root, 'my-feature', '- [x] D1 A criterion. Verified by: `true`\n');
  assert.equal(flow(root, 'gate', 'open', 'my-feature').code, 0);
});

test('gate open returns 2 for an open D<n> criterion and names it', () => {
  const root = project();
  changeWithDod(root, 'my-feature', '- [ ] D1 A criterion. Verified by: `true`\n');
  const run = flow(root, 'gate', 'open', 'my-feature');
  assert.equal(run.code, 2);
  assert.match(run.out, /D1 A criterion/);
});

test('gate open returns 2 for an open task, and 2 without tasks.md', () => {
  const root = project();
  changeWithDod(root, 'my-feature', '- [x] D1 A criterion. Verified by: `true`\n', '- [ ] 1.1 To do.\n');
  assert.equal(flow(root, 'gate', 'open', 'my-feature').code, 2);
  assert.equal(flow(root, 'gate', 'open', 'unknown').code, 2);
});

test('gate replay returns 0 when each command passes, boxes open or checked', () => {
  const root = project();
  changeWithDod(root, 'my-feature', '- [ ] D1 Open. Verified by: `true`\n- [x] D2 Checked. Verified by: `true`\n');
  const run = flow(root, 'gate', 'replay', 'my-feature');
  assert.equal(run.code, 0, run.out);
  assert.match(readFileSync(join(root, 'openspec/changes/my-feature/tasks.md'), 'utf8'), /\[ \] D1/, 'the replay checks nothing');
});

test('gate replay returns 30 when the command of a checked criterion fails, and names the criterion', () => {
  const root = project();
  changeWithDod(root, 'my-feature', '- [x] D1 Checked but wrong. Verified by: `false`\n');
  const run = flow(root, 'gate', 'replay', 'my-feature');
  assert.equal(run.code, 30);
  assert.match(run.out, /D1/);
});

test('gate archive returns 30 while the change is not under openspec/changes/archive/', () => {
  const root = project();
  const run = flow(root, 'gate', 'archive', 'existing');
  assert.equal(run.code, 30);
  assert.match(run.out, /archive/);
});

test('gate archive returns 30 when the directory of the change still exists', () => {
  const root = project();
  mkdirSync(join(root, 'openspec/changes/archive/2026-10-26-existing'), { recursive: true });
  const run = flow(root, 'gate', 'archive', 'existing');
  assert.equal(run.code, 30);
  assert.match(run.out, /still exists/);
});

test('gate scope archive accepts openspec/ and accept is limited to the directory of the change', () => {
  const root = project();
  dirty(root, 'openspec/changes/archive/2026-10-26-existing/proposal.md', 'openspec/specs/cap/spec.md');
  assert.equal(flow(root, 'gate', 'scope', 'archive', 'existing').code, 0);
  assert.equal(flow(root, 'gate', 'scope', 'accept', 'existing').code, 30);
});

test('init archive and accept need an existing change', () => {
  const root = project();
  assert.equal(flow(root, 'init', 'archive', 'unknown').code, 2);
  assert.equal(flow(root, 'init', 'accept', 'unknown').code, 2);
  assert.equal(flow(root, 'init', 'accept', 'existing').code, 0);
});

test('commit accept has its message', () => {
  const root = project();
  dirty(root, 'openspec/changes/existing/acceptance.yaml');
  assert.equal(flow(root, 'commit', 'accept', 'existing').code, 0);
  assert.equal(lastMessage(root).trim(), 'docs(openspec): accept change existing');
});

test('accept writes reviewer, date, fingerprint and commit', () => {
  const root = project();
  changeWithDod(root, 'my-feature', '- [x] D1 A criterion. Verified by: `true`\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  const run = flow(root, 'accept', 'my-feature');
  assert.equal(run.code, 0, run.out);
  const text = readFileSync(join(root, 'openspec/changes/my-feature/acceptance.yaml'), 'utf8');
  assert.match(text, /^reviewer: ".+"$/m);
  assert.match(text, /^date: \d{4}-\d{2}-\d{2}$/m);
  assert.match(text, /^fingerprint: [0-9a-f]{64}$/m);
  assert.match(text, new RegExp(`^commit: ${git(root, 'rev-parse', 'HEAD')}$`, 'm'));
});

test('accept and merge exit 2 when run from an agent step', () => {
  const root = project();
  for (const env of [{ ...ATTENDED, AWF_AGENT_STEP: '1' }, { ...process.env, CLAUDE_CODE_SESSION_ATTENDED: '0' }]) {
    for (const sub of ['accept', 'merge']) {
      const run = spawnSync('bash', [FLOW, sub, 'existing'], { cwd: root, encoding: 'utf8', env });
      assert.equal(run.status, 2, sub);
      assert.match(run.stdout + run.stderr, /agent step/);
    }
  }
});

test('merge merges the proposal branch into main with a merge commit', () => {
  const root = withGate(project());
  assert.equal(flow(root, 'init', 'update', 'existing').code, 0);
  const tree = join(root, '.worktrees/propose-existing');
  writeFileSync(join(tree, 'openspec/changes/existing/design.md'), '# design\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'design');
  const run = spawnSync('bash', [FLOW, 'merge', 'existing'], { cwd: tree, encoding: 'utf8', env: ATTENDED });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(lastMessage(root).trim(), 'merge(existing): accept change existing');
  assert.equal(git(root, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3, 'two parents');
  assert.ok(existsSync(join(root, 'openspec/changes/existing/design.md')));
});

test('merge returns 30 and leaves main unchanged when a gate step fails', () => {
  const root = withGate(project());
  assert.equal(flow(root, 'init', 'update', 'existing').code, 0);
  const tree = join(root, '.worktrees/propose-existing');
  mkdirSync(join(tree, 'api'), { recursive: true });
  writeFileSync(join(tree, 'api/a.php'), '<?php\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'api');
  const before = git(root, 'rev-parse', 'HEAD');
  const env = { ...ATTENDED, MERGE_GATE_CMD_PHPSTAN: 'exit 1', MERGE_GATE_CMD_PSALM: 'true', MERGE_GATE_CMD_UNIT: 'true', MERGE_GATE_CMD_FUNCTIONAL: 'true' };
  const run = spawnSync('bash', [FLOW, 'merge', 'existing'], { cwd: tree, encoding: 'utf8', env });
  assert.equal(run.status, 30, run.stdout + run.stderr);
  assert.match(run.stderr, /step PHPSTAN failed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
});

test('merge returns 2 when the proposal branch does not exist', () => {
  assert.equal(flow(project(), 'merge', 'existing').code, 2);
});

test('context lists the changes, the worktrees and the valid waivers', () => {
  const root = project();
  assert.equal(flow(root, 'waive', 'existing', 'review-ts', '--reason', 'trial').code, 0);
  const run = flow(root, 'context');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /Changes in progress:\n {2}existing/);
  assert.match(run.out, /Worktrees:/);
  assert.match(run.out, /Valid waivers:\n {2}- \{change: existing, gate: review-ts/);
});

test('flow-accept runs no replay and goes through flow-gate', () => {
  const yaml = readFileSync(join(WORKFLOWS, 'flow-accept.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /gate replay/);
  assert.match(yaml, /init:[\s\S]*?on_success: gate\n/);
  assert.match(yaml, /\n  gate:\n    type: call_workflow[\s\S]*?workflow: flow-gate\n/);
});

test('accept then merge accept a change whose Definition of Done would fail on replay', () => {
  const root = withGate(project());
  assert.equal(flow(root, 'init', 'propose', 'my-feature').code, 0);
  const tree = join(root, '.worktrees/propose-my-feature');
  changeWithDod(tree, 'my-feature', '- [ ] D1 Code missing. Verified by: `false`\n', '- [ ] 1.1 To do.\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'propose');
  const accept = flow(tree, 'accept', 'my-feature');
  assert.equal(accept.code, 0, accept.out);
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'accept');
  const merge = flow(tree, 'merge', 'my-feature');
  assert.equal(merge.code, 0, merge.out);
  assert.ok(existsSync(join(root, 'openspec/changes/my-feature/acceptance.yaml')));
});

test('waive exits 2 from an agent step, names flow-waive and writes nothing', () => {
  const root = projectWithAuthor();
  for (const env of [{ ...ATTENDED, AWF_AGENT_STEP: '1' }, { ...process.env, CLAUDE_CODE_SESSION_ATTENDED: '0' }]) {
    const run = spawnSync('bash', [FLOW, 'waive', 'my-feature', 'scope', '--reason', 'x'], { cwd: root, encoding: 'utf8', env });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /agent step[\s\S]*flow-waive/);
  }
  assert.equal(existsSync(registry(root)), false);
});

// flow-waive and flow-explore, run by awf in a throwaway repository. Skipped when awf is not installed.
const AWF_AVAILABLE = spawnSync('awf', ['--version'], { encoding: 'utf8' }).error === undefined;

function withEntryWorkflows(): string {
  const root = projectWithAuthor();
  mkdirSync(join(root, '.awf/workflows'), { recursive: true });
  mkdirSync(join(root, '.awf/scripts'), { recursive: true });
  for (const name of ['flow-waive', 'flow-explore']) writeFileSync(join(root, '.awf/workflows', `${name}.yaml`), readFileSync(join(WORKFLOWS, `${name}.yaml`)));
  for (const name of ['flow.sh', 'commands.sh']) writeFileSync(join(root, '.awf/scripts', name), readFileSync(join(dirname(FLOW), name)));
  writeFileSync(join(root, '.gitignore'), '.awf/\n');
  return root;
}

function awfRun(root: string, workflow: string, inputs: Record<string, string>) {
  const run = spawnSync('awf', ['run', workflow, '--output', 'buffered', ...Object.entries(inputs).flatMap(([name, value]) => ['--input', `${name}=${value}`])], { cwd: root, encoding: 'utf8', env: ATTENDED });
  return { status: run.status, out: run.stdout + run.stderr };
}

test('flow-waive records the waiver, with quotes and $( ) in the reason kept as text', { skip: !AWF_AVAILABLE }, () => {
  const root = withEntryWorkflows();
  const run = awfRun(root, 'flow-waive', { change: 'my-feature', gate: 'scope', reason: 'it\'s slow; $(touch pwned)', days: '7' });

  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /Waiver granted to my-feature for gate scope until/);
  const line = readFileSync(registry(root), 'utf8');
  assert.match(line, /reason: "it's slow; \$\(touch pwned\)"/);
  assert.match(line, new RegExp(`expires: ${dayPlus(7)}`));
  assert.equal(existsSync(join(root, 'pwned')), false);
});

test('flow-waive fails on invalid input and gives the reason', { skip: !AWF_AVAILABLE }, () => {
  const root = withEntryWorkflows();
  const run = awfRun(root, 'flow-waive', { change: 'my-feature', gate: 'scope', reason: 'x', days: '45' });

  assert.notEqual(run.status, 0);
  assert.match(run.out, /30 days at most/);
  assert.equal(existsSync(registry(root)), false);
});

test('flow-explore prints the context at start, and at finish names a file changed under openspec/', { skip: !AWF_AVAILABLE }, () => {
  const root = withEntryWorkflows();
  const start = awfRun(root, 'flow-explore', { step: 'start' });
  assert.equal(start.status, 0, start.out);
  assert.match(start.out, /Changes in progress:[\s\S]*existing/);

  assert.equal(awfRun(root, 'flow-explore', { step: 'finish' }).status, 0);
  dirty(root, 'openspec/changes/idea/proposal.md');
  const finish = awfRun(root, 'flow-explore', { step: 'finish' });
  assert.notEqual(finish.status, 0);
  assert.match(finish.out, /openspec\/changes\/idea\/proposal\.md/);
});

// ---- Run mode: a Susan run (NEXUS_AGENT_RUN_ID set) is a fresh clone positioned on main; no worktree, no "run again".

// A clone of `origin`, as a Susan run has it: every branch of the origin reachable, the clone on main.
function runClone(origin: string): string {
  const clone = mkdtempSync(join(tmpdir(), 'flow-run-'));
  roots.push(clone);
  rmSync(clone, { recursive: true, force: true });
  spawnSync('git', ['clone', '-q', origin, clone], { encoding: 'utf8' });
  return clone;
}

test('run mode: init propose switches the clone to a new docs/propose-<change> from main, without a worktree', () => {
  const clone = runClone(project());
  const run = flowEnv(clone, RUN, 'init', 'propose', 'my-feature');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /Run mode: branch docs\/propose-my-feature checked out/);
  assert.equal(git(clone, 'branch', '--show-current'), 'docs/propose-my-feature');
  assert.equal(existsSync(join(clone, '.worktrees')), false);
});

test('run mode: init update reads the change on a branch that exists only on the origin', () => {
  const origin = project();
  git(origin, 'switch', '-q', '-c', 'docs/propose-fresh');
  mkdirSync(join(origin, 'openspec/changes/fresh'), { recursive: true });
  writeFileSync(join(origin, 'openspec/changes/fresh/proposal.md'), '# fresh\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'fresh');
  git(origin, 'switch', '-q', 'main');
  const clone = runClone(origin);
  const run = flowEnv(clone, RUN, 'init', 'update', 'fresh');
  assert.equal(run.code, 0, run.out);
  assert.equal(git(clone, 'branch', '--show-current'), 'docs/propose-fresh');
  assert.ok(existsSync(join(clone, 'openspec/changes/fresh/proposal.md')));
});

test('run mode: init update of an unknown change exits 2 and names the available changes', () => {
  const clone = runClone(project());
  const run = flowEnv(clone, RUN, 'init', 'update', 'unknown');
  assert.equal(run.code, 2);
  assert.match(run.out, /not in openspec\/changes/);
  assert.match(run.out, /existing/);
  assert.equal(existsSync(join(clone, '.worktrees')), false);
});

test('run mode: init propose of a change that already exists exits 2', () => {
  const clone = runClone(project());
  assert.equal(flowEnv(clone, RUN, 'init', 'propose', 'existing').code, 2);
});

test('run mode: switch moves the clone to change/<change>, and refuses outside a run', () => {
  const clone = runClone(project());
  const outside = flow(clone, 'switch', 'change/existing');
  assert.equal(outside.code, 2);
  assert.match(outside.out, /NEXUS_AGENT_RUN_ID/);
  const run = flowEnv(clone, RUN, 'switch', 'change/existing');
  assert.equal(run.code, 0, run.out);
  assert.equal(git(clone, 'branch', '--show-current'), 'change/existing');
  assert.equal(flowEnv(clone, RUN, 'switch', 'Not A Branch').code, 2);
});

test('run mode: merge leaves main untouched and says that a person merges the branch', () => {
  const clone = runClone(withGate(project()));
  assert.equal(flowEnv(clone, RUN, 'init', 'update', 'existing').code, 0);
  writeFileSync(join(clone, 'note.md'), 'x\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'note');
  const before = git(clone, 'rev-parse', 'main');
  const run = flowEnv(clone, RUN, 'merge', 'existing');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /not merged into main/);
  assert.equal(git(clone, 'rev-parse', 'main'), before);
});
