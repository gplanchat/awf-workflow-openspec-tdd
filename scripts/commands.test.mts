// The git defaults of commands.sh and the dispatch to .awf/commands.yaml, run in throwaway git repositories.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'commands.sh');
const work = mkdtempSync(join(tmpdir(), 'commands-'));
after(() => rmSync(work, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
delete ENV.WORKTREE_BIN;
delete ENV.E2E_CMD;
delete ENV.NEXUS_AGENT_RUN_ID; // run mode stays off unless a test sets it
for (const name of ['FLOW_MAX_CHANGES', 'FLOW_MAX_TASKS', 'FLOW_MAX_TOTAL']) delete ENV[name];

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const run = (cwd: string, args: string[], env: Record<string, string> = {}) => spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env } });

function repo(): string {
  const root = mkdtempSync(join(work, 'r-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.awf/status/\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf', 'languages.yaml'), 'docs:\n  workflow: free-task\n'); // merge-gate.sh reads it
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('create adds .worktrees/<change> on branch change/<change>, and reuses the branch when it exists', () => {
  const root = repo();
  const first = run(root, ['create', 'demo']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(git(join(root, '.worktrees', 'demo'), 'branch', '--show-current'), 'change/demo');
  git(root, 'worktree', 'remove', '.worktrees/demo');
  assert.equal(run(root, ['create', 'demo']).status, 0);
  assert.equal(run(root, ['create', 'Not_Kebab']).status, 2);
});

test('settings: the option wins over the environment, the environment over the defaults; an invalid value exits 2', () => {
  const root = repo();
  assert.deepEqual(JSON.parse(run(root, ['settings']).stdout), { max_changes: 2, max_tasks: 1, max_total: 3 });
  const mixed = run(root, ['settings', '--max-tasks', '4'], { FLOW_MAX_TASKS: '2', FLOW_MAX_TOTAL: '5' });
  assert.deepEqual(JSON.parse(mixed.stdout), { max_changes: 2, max_tasks: 4, max_total: 5 });
  assert.equal(run(root, ['settings', '--max-total', '0']).status, 2);
});

test('settings in a Susan run: max_tasks is always 1, the other settings are kept, the lowering is said on stderr', () => {
  const root = repo();
  const result = run(root, ['settings', '--max-tasks', '4', '--max-changes', '3'], { NEXUS_AGENT_RUN_ID: 'run-1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { max_changes: 3, max_tasks: 1, max_total: 3 });
  assert.match(result.stderr, /Run mode: max-tasks 4 lowered to 1/);
});

test('claim is all or none against a live run, a dead run\'s claim is taken over, release frees only the run\'s own', () => {
  const root = repo();
  const live = String(process.pid);
  assert.equal(run(root, ['claim', '--run', 'r1', '--pid', live, 'a', 'b']).status, 0);
  assert.equal(run(root, ['claim', '--run', 'r1', '--pid', live, 'a']).status, 0, 'the same run claims again');
  const held = run(root, ['claim', '--run', 'r2', '--pid', live, 'c', 'b']);
  assert.equal(held.status, 1);
  assert.match(held.stderr, /change b/);
  const claims = join(root, '.git', 'awf', 'claims');
  assert.equal(existsSync(join(claims, 'c')), false, 'c is given back when b is held');
  assert.equal(run(root, ['release', '--run', 'r2', 'a']).status, 0);
  assert.equal(existsSync(join(claims, 'a')), true, 'r2 does not free r1\'s claim');
  writeFileSync(join(claims, 'd'), 'gone 999999999\n');
  assert.equal(run(root, ['claim', '--run', 'r2', '--pid', live, 'd']).status, 0);
  assert.equal(readFileSync(join(claims, 'd'), 'utf8').split(' ')[0], 'r2');
});

test('verify fails when the main worktree has uncommitted changes outside .awf/status', () => {
  const root = repo();
  mkdirSync(join(root, '.awf', 'status'), { recursive: true });
  writeFileSync(join(root, '.awf', 'status', 'x.json'), '{}');
  assert.equal(run(root, ['verify', 'demo']).status, 0);
  writeFileSync(join(root, 'README.md'), 'leak\n');
  const leaky = run(root, ['verify', 'demo']);
  assert.equal(leaky.status, 1);
  assert.match(leaky.stderr, /README\.md/);
});

test('merge brings change/<change> into main; a conflict is aborted and leaves main unchanged', () => {
  const root = repo();
  run(root, ['create', 'ok']);
  const tree = join(root, '.worktrees', 'ok');
  writeFileSync(join(tree, 'new.txt'), 'x\n');
  git(tree, 'add', '.');
  git(tree, 'commit', '-q', '-m', 'ok');
  const merged = run(tree, ['merge', 'ok']);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(existsSync(join(root, 'new.txt')), true);

  run(root, ['create', 'clash']);
  const clash = join(root, '.worktrees', 'clash');
  writeFileSync(join(clash, 'README.md'), 'theirs\n');
  git(clash, 'commit', '-q', '-am', 'theirs');
  writeFileSync(join(root, 'README.md'), 'ours\n');
  git(root, 'commit', '-q', '-am', 'ours');
  const before = git(root, 'rev-parse', 'HEAD');
  const conflict = run(root, ['merge', 'clash']);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /(conflict|conflit).*README\.md/i, 'apply-many.sh reads the files from this line');
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('a declaration in .awf/commands.yaml replaces the default and receives the arguments; WORKTREE_BIN wins over it', () => {
  const root = repo();
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf', 'commands.yaml'), "# comment\nmounted: echo declared\nrun-tasks: 'printf \"%s,\"'  # trailing comment\n");
  assert.equal(run(root, ['mounted']).stdout, 'declared\n');
  assert.equal(run(root, ['run-tasks', 'demo', '1.1']).stdout, 'demo,1.1,', 'a trailing comment keeps the arguments');
  run(root, ['create', 'wt']);
  assert.equal(run(join(root, '.worktrees', 'wt'), ['mounted']).stdout, 'declared\n', 'read from the main worktree');
  assert.equal(run(root, ['claim', '--run', 'r', '--pid']).status, 2, 'an option without a value stops');
  assert.equal(run(root, ['--declared', 'mounted']).status, 0);
  assert.equal(run(root, ['--declared', 'e2e']).status, 1);
  assert.equal(run(root, ['e2e']).status, 2, 'no default for e2e');
  assert.equal(run(root, ['mounted'], { WORKTREE_BIN: 'echo bin' }).stdout, 'bin mounted\n');
});

// A fake awf for run-tasks and run-all. apply-task checks the task and its slices in tasks.md, writes src/<task>.txt
// (or shared.txt with FAKE_SHARED=1) and commits; a task or change listed in FAKE_FAIL fails. Every run records how many
// runs were in progress when it started, to check the caps.
const FAKE_AWF = `#!/usr/bin/env bash
ref=$2; shift 2
for a in "$@"; do case $a in change=*) change=\${a#change=} ;; task=*) task=\${a#task=} ;; esac; done
echo "$ref change=$change task=\${task:-} cwd=$PWD" >> "$FAKE_DIR/calls.log"
mkdir -p "$FAKE_DIR/running" .awf/status
touch "$FAKE_DIR/running/$$"
ls "$FAKE_DIR/running" | wc -l >> "$FAKE_DIR/counts"
sleep 0.3
rm -f "$FAKE_DIR/running/$$"
if [[ $ref == apply-change ]]; then
  [[ " \${FAKE_FAIL:-} " == *" $change "* ]] && exit 1
  echo '{"status":"done"}' > .awf/status/apply-change.json; exit 0
fi
if [[ " \${FAKE_FAIL:-} " == *" $task "* ]]; then echo '{"status":"failed"}' > .awf/status/apply-task.json; exit 1; fi
sed -i -E "s/^( *- )\\\\[ \\\\] ($task|$task\\\\.[0-9]+) /\\\\1[x] \\\\2 /" "openspec/changes/$change/tasks.md"
mkdir -p src
if [[ -n \${FAKE_SHARED:-} ]]; then echo "$task" > shared.txt; else echo "$task" > "src/$task.txt"; fi
git add -A . && git commit -q -m "task $task"
echo '{"status":"done"}' > .awf/status/apply-task.json
`;

const TASKS = `## 1. Group (parallel)
- [ ] 1.1 first
  - [ ] 1.1.1 [php] slice a
- [ ] 1.2 second
  - [ ] 1.2.1 [php] slice b
- [ ] 1.3 third
- [ ] 1.4 fourth
`;

function parallelRepo() {
  const root = repo();
  mkdirSync(join(root, 'openspec', 'changes', 'demo'), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), TASKS);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'tasks');
  const fake = mkdtempSync(join(work, 'fake-'));
  writeFileSync(join(fake, 'awf'), FAKE_AWF, { mode: 0o755 });
  assert.equal(run(root, ['create', 'demo']).status, 0);
  const env = { AWF_BIN: join(fake, 'awf'), FAKE_DIR: fake, FLOW_WORKFLOW_PREFIX: '', FLOW_SLOTS_DIR: join(fake, 'slots') };
  return { root, tree: join(root, '.worktrees', 'demo'), fake, env };
}

const peak = (fake: string) => Math.max(...readFileSync(join(fake, 'counts'), 'utf8').trim().split('\n').map(Number));

test('run-tasks applies each task in its sub-worktree, at most --max-tasks at once, and merges every checkbox', () => {
  const { tree, fake, env } = parallelRepo();
  const result = run(tree, ['run-tasks', 'demo', '--max-tasks', '2', '--max-total', '3', '1.1', '1.2', '1.3', '1.4'], env);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(tree, '.awf', 'status', 'run-tasks.json'), 'utf8'));
  assert.deepEqual(report, { tasks: Object.fromEntries(['1.1', '1.2', '1.3', '1.4'].map((id) => [id, { status: 'done', merged: true }])), status: 'done' });
  const tasks = readFileSync(join(tree, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8');
  assert.doesNotMatch(tasks, /\[ \]/, 'every task and slice box is checked on the change branch');
  for (const id of ['1.1', '1.2', '1.3', '1.4']) assert.equal(existsSync(join(tree, 'src', `${id}.txt`)), true);
  assert.equal(peak(fake), 2);
  assert.equal(existsSync(join(tree, '..', 'demo--1.1')), false, 'a merged sub-worktree is removed');
  assert.equal(git(tree, 'branch', '--list', 'change/demo--*'), '');
});

test('run-tasks: --max-total caps the tasks running on the machine', () => {
  const { tree, fake, env } = parallelRepo();
  assert.equal(run(tree, ['run-tasks', 'demo', '--max-tasks', '4', '--max-total', '1', '1.1', '1.2', '1.3'], env).status, 0);
  assert.equal(peak(fake), 1);
});

test('run-tasks keeps a failed task\'s sub-worktree, reports it, and a rerun resumes it', () => {
  const { tree, env } = parallelRepo();
  const failed = run(tree, ['run-tasks', 'demo', '--max-tasks', '2', '1.1', '1.2', '1.3'], { ...env, FAKE_FAIL: '1.2' });
  assert.equal(failed.status, 1);
  const report = JSON.parse(readFileSync(join(tree, '.awf', 'status', 'run-tasks.json'), 'utf8'));
  assert.deepEqual(report.tasks['1.2'], { status: 'failed', merged: false });
  assert.equal(report.status, 'failed');
  assert.equal(existsSync(join(tree, '..', 'demo--1.2')), true);
  const resumed = run(tree, ['run-tasks', 'demo', '1.2'], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stderr, /Resuming the existing sub-worktree of task 1\.2/);
  assert.doesNotMatch(readFileSync(join(tree, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[ \] 1\.[123]/);
});

test('run-tasks: a conflict outside the checkboxes is aborted and the task is not merged', () => {
  const { tree, env } = parallelRepo();
  const result = run(tree, ['run-tasks', 'demo', '--max-tasks', '2', '1.1', '1.2'], { ...env, FAKE_SHARED: '1' });
  assert.equal(result.status, 1);
  const report = JSON.parse(readFileSync(join(tree, '.awf', 'status', 'run-tasks.json'), 'utf8'));
  assert.deepEqual(report.tasks, { '1.1': { status: 'done', merged: true }, '1.2': { status: 'done', merged: false } });
  assert.equal(readFileSync(join(tree, 'shared.txt'), 'utf8'), '1.1\n');
  assert.equal(git(tree, 'status', '--porcelain'), '');
});

test('run-tasks refuses a change worktree with uncommitted changes', () => {
  const { tree, env } = parallelRepo();
  writeFileSync(join(tree, 'README.md'), 'dirty\n');
  assert.equal(run(tree, ['run-tasks', 'demo', '1.1'], env).status, 2);
});

test('run-all runs apply-change in each change worktree, at most --max-changes at once; a failure exits 1', () => {
  const { root, fake, env } = parallelRepo();
  assert.equal(run(root, ['create', 'other']).status, 0);
  const result = run(root, ['run-all', '--max-changes', '1', 'demo', 'other'], { ...env, FAKE_FAIL: 'other' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /apply-change failed for other/);
  assert.equal(peak(fake), 1);
  assert.equal(existsSync(join(root, '.worktrees', 'demo', '.awf', 'status', 'apply-change.json')), true);
  assert.match(readFileSync(join(fake, 'calls.log'), 'utf8'), /^apply-change change=demo/m);
});

test('run-tasks: once the conflict is resolved in the sub-worktree, a rerun merges the task without running it again', () => {
  const { tree, fake, env } = parallelRepo();
  assert.equal(run(tree, ['run-tasks', 'demo', '--max-tasks', '2', '1.1', '1.2'], { ...env, FAKE_SHARED: '1' }).status, 1);
  const sub = join(tree, '..', 'demo--1.2');
  spawnSync('git', ['merge', '-q', 'change/demo'], { cwd: sub, env: ENV });
  writeFileSync(join(sub, 'shared.txt'), '1.1\n1.2\n');
  git(sub, 'checkout', '--ours', 'openspec/changes/demo/tasks.md');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '--no-edit');
  const rerun = run(tree, ['run-tasks', 'demo', '1.2'], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(readFileSync(join(tree, 'shared.txt'), 'utf8'), '1.1\n1.2\n');
  assert.equal(existsSync(sub), false);
  assert.equal(readFileSync(join(fake, 'calls.log'), 'utf8').split('\n').filter((line) => line.includes('task=1.2')).length, 1);
});

test('run-tasks names the workflow <name>/apply-task from the pack manifest, wherever the pack is installed', () => {
  const { tree, fake, env } = parallelRepo();
  const scripts = join(fake, 'usr', 'share', 'awf', 'packs', 'pack-dir', 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, '..', 'manifest.yaml'), 'name: "xyz"\nversion: 0.0.1\n');
  for (const name of ['commands.sh', 'merge-gate.sh']) writeFileSync(join(scripts, name), readFileSync(join(dirname(SCRIPT), name)));
  const { FLOW_WORKFLOW_PREFIX: _, ...rest } = env;
  const result = spawnSync('bash', [join(scripts, 'commands.sh'), 'run-tasks', 'demo', '1.1'], { cwd: tree, encoding: 'utf8', env: { ...ENV, ...rest } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(fake, 'calls.log'), 'utf8'), /^xyz\/apply-task change=demo task=1\.1/m);
});

test('create links packs installed in the main worktree without being committed, and git ignores the link', () => {
  const root = repo();
  mkdirSync(join(root, '.awf', 'workflow-packs', 'p'), { recursive: true });
  writeFileSync(join(root, '.awf', 'workflow-packs', 'p', 'manifest.yaml'), 'name: p\n');
  assert.equal(run(root, ['create', 'demo']).status, 0);
  const tree = join(root, '.worktrees', 'demo');
  assert.equal(existsSync(join(tree, '.awf', 'workflow-packs', 'p', 'manifest.yaml')), true);
  assert.equal(git(tree, 'status', '--porcelain'), '');
});

test('ask: the default prints the question, the options and the resume line of the pack workflow', () => {
  const root = repo();
  const result = run(root, ['ask', '--run', 'r-1', '--kind', 'decision', '--question', 'Proceed?', '--options', 'proceed,revise', '--recommended', 'revise', '--resume-step', 'check', '--input', 'egm_decision']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Question \(decision\): Proceed\?$/m);
  assert.match(result.stdout, /^Options: proceed, revise \(recommended: revise\)$/m);
  assert.match(result.stdout, /^To answer: AWF_WORKFLOWS_PATH=\S+\/workflows awf resume r-1 --from check --input egm_decision=<answer>$/m);
});

test('ask: exit 2 without --run, --question, --resume-step or --input, or with an unknown option', () => {
  const root = repo();
  assert.equal(run(root, ['ask', '--question', 'Proceed?', '--resume-step', 'check', '--input', 'x']).status, 2);
  assert.equal(run(root, ['ask', '--run', 'r', '--question', 'q', '--resume-step', 'check', '--input', 'x', '--color', 'red']).status, 2);
});

test('ask: a project replaces it in .awf/commands.yaml', () => {
  const root = repo();
  writeFileSync(join(root, '.awf', 'commands.yaml'), 'ask: echo filed\n');
  assert.equal(run(root, ['ask', '--run', 'r', '--question', 'q', '--resume-step', 'check', '--input', 'x']).stdout, 'filed --run r --question q --resume-step check --input x\n');
});
