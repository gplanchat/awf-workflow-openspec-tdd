// Flow control of apply-many.yaml and apply-many.sh, tried with awf on a throwaway project. commands.sh (worktree) and the
// end-to-end tests are replaced by doubles (WORKTREE_BIN, E2E_CMD) that log their calls in calls.log.
// No agent runs. The tests are skipped when awf or jq is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const available = ['awf', 'jq'].every((tool) => spawnSync(tool, ['--version'], { encoding: 'utf8' }).error === undefined);
const AWF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'apply-many-'));
after(() => rmSync(work, { recursive: true, force: true }));

// The names decide how the double behaves: bad* fails when applied, leaky when verified, conflict when merged,
// nocreate when created.
const FAKE_WT = `#!/usr/bin/env bash
cmd=$1; shift
echo "worktree $cmd $*" >> calls.log
case "$cmd" in
  claim) [[ "$*" == *held* ]] && { echo "Another apply-many run is applying the change held."; echo "Wait for it to finish, or choose another change."; exit 1; }; true ;;
  release) true ;;
  create) [[ $1 == nocreate ]] && { echo "the worktree already exists"; exit 1; }; mkdir -p ".worktrees/$1/.awf/status" ;;
  run-all)
    while [[ $1 == --max-* ]]; do shift 2; done
    for c in "$@"; do
      if [[ $c == bad* ]]; then
        echo '{"change":"'$c'","done":["1.1"],"failed":{"id":"1.2","phase":"review","status":30},"status":"failed"}' > ".worktrees/$c/.awf/status/apply-change.json"
      else
        echo '{"change":"'$c'","done":["1.1","1.2"],"failed":null,"status":"done"}' > ".worktrees/$c/.awf/status/apply-change.json"
      fi
    done ;;
  verify) [[ $1 == leaky ]] && { echo "main changed: README.md"; exit 1; }; true ;;
  merge) [[ $1 == conflict ]] && { echo "CONFLICT (content): Merge conflict in README.md"; echo "Merge aborted, main is back to its previous state."; exit 1; }; true ;;
esac
`;

function project(existing?: string): string {
  const root = existing ?? mkdtempSync(join(work, 'p-'));
  mkdirSync(join(root, '.awf', 'workflows'), { recursive: true });
  mkdirSync(join(root, '.awf', 'scripts'), { recursive: true });
  cpSync(join(AWF_DIR, 'workflows', 'apply-many.yaml'), join(root, '.awf', 'workflows', 'apply-many.yaml'));
  cpSync(join(AWF_DIR, 'scripts', 'apply-many.sh'), join(root, '.awf', 'scripts', 'apply-many.sh'));
  cpSync(join(AWF_DIR, 'scripts', 'commands.sh'), join(root, '.awf', 'scripts', 'commands.sh'));
  writeFileSync(join(root, 'fake-worktree'), FAKE_WT, { mode: 0o755 });
  return root;
}

interface Report {
  status: string;
  e2e: string;
  changes: Array<{ change: string; created: boolean; applied: boolean; tasks_done: string[]; failed: { id: string } | null; verified: boolean; merged: boolean; conflict: string[]; error: string | null }>;
}

function applyMany(changes: string, inputs: Record<string, string> = {}, existing?: string) {
  const root = project(existing);
  const result = spawnSync('awf', ['run', 'apply-many', '--output', 'buffered', '--input', `changes=${changes}`, ...Object.entries(inputs).flatMap(([name, value]) => ['--input', `${name}=${value}`])], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WORKTREE_BIN: './fake-worktree', E2E_CMD: 'echo e2e >> calls.log' },
  });
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
  const reportText = read('.awf/status/apply-many.json');
  const allCalls = read('calls.log').split('\n').filter((line) => line !== '');
  return {
    root,
    claims: allCalls.filter((line) => /^worktree (claim|release) /.test(line)),
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: allCalls.filter((line) => !/^worktree (claim|release) /.test(line)),
    report: reportText === '' ? null : (JSON.parse(reportText) as Report),
  };
}

const byName = (report: Report | null, name: string) => report?.changes.find((c) => c.change === name);

test('apply-many: three changes succeed, created, applied, verified, merged in order, then the end-to-end tests', { skip: !available }, () => {
  const run = applyMany('alpha beta gamma');

  assert.deepEqual(run.calls, [
    'worktree create alpha', 'worktree create beta', 'worktree create gamma',
    'worktree run-all alpha beta gamma',
    'worktree verify alpha', 'worktree verify beta', 'worktree verify gamma',
    'worktree merge alpha', 'worktree merge beta', 'worktree merge gamma',
    'e2e',
  ]);
  assert.equal(run.report?.status, 'done');
  assert.equal(run.report?.e2e, 'passed');
  assert.deepEqual(run.report?.changes.map((c) => [c.change, c.applied, c.verified, c.merged]), [['alpha', true, true, true], ['beta', true, true, true], ['gamma', true, true, true]]);
  assert.equal(run.status, 0);
});

test('apply-many: the three parallelism settings go to commands.sh run-all, with no invented default', { skip: !available }, () => {
  assert.ok(applyMany('alpha beta', { max_changes: '3' }).calls.includes('worktree run-all --max-changes 3 alpha beta'));
  assert.ok(applyMany('alpha beta', { max_changes: '3', max_tasks: '2', max_total: '4' }).calls.includes('worktree run-all --max-changes 3 --max-tasks 2 --max-total 4 alpha beta'));
  assert.ok(applyMany('alpha', { max_tasks: '2' }).calls.includes('worktree run-all --max-tasks 2 alpha'));
});

test('apply-many: the former name max is kept and max_changes wins', { skip: !available }, () => {
  assert.ok(applyMany('alpha beta', { max: '3' }).calls.includes('worktree run-all --max-changes 3 alpha beta'));
  assert.ok(applyMany('alpha beta', { max: '3', max_changes: '1' }).calls.includes('worktree run-all --max-changes 1 alpha beta'));
});

test('apply-many: a change that fails to apply is neither verified nor merged, the others go on', { skip: !available }, () => {
  const run = applyMany('alpha bad-one beta');

  assert.deepEqual(byName(run.report, 'bad-one'), { change: 'bad-one', created: true, applied: false, tasks_done: ['1.1'], failed: { id: '1.2', phase: 'review', status: 30 }, verified: false, merged: false, conflict: [], error: null });
  assert.ok(!run.calls.includes('worktree verify bad-one'));
  assert.ok(!run.calls.includes('worktree merge bad-one'));
  assert.deepEqual(run.calls.filter((call) => call.startsWith('worktree merge')), ['worktree merge alpha', 'worktree merge beta']);
  assert.equal(run.report?.e2e, 'passed');
  assert.equal(run.report?.status, 'failed');
  assert.notEqual(run.status, 0);
});

test('apply-many: a change that wrote outside its worktree is not merged', { skip: !available }, () => {
  const run = applyMany('alpha leaky');

  assert.equal(byName(run.report, 'leaky')?.verified, false);
  assert.match(byName(run.report, 'leaky')?.error ?? '', /isolation: main changed: README\.md/);
  assert.deepEqual(run.calls.filter((call) => call.startsWith('worktree merge')), ['worktree merge alpha']);
});

test('apply-many: at the first conflict the merges stop, the next ones are not tried, the files are named', { skip: !available }, () => {
  const run = applyMany('alpha conflict beta');

  assert.deepEqual(run.calls.filter((call) => call.startsWith('worktree merge')), ['worktree merge alpha', 'worktree merge conflict']);
  assert.deepEqual(byName(run.report, 'conflict')?.conflict, ['README.md']);
  assert.equal(byName(run.report, 'alpha')?.merged, true);
  assert.equal(byName(run.report, 'beta')?.merged, false);
  assert.match(byName(run.report, 'beta')?.error ?? '', /not tried/);
  assert.equal(run.report?.status, 'failed');
});

test('apply-many: a worktree that cannot be created is reported and the other changes go on', { skip: !available }, () => {
  const run = applyMany('nocreate alpha');

  assert.match(byName(run.report, 'nocreate')?.error ?? '', /worktree creation: the worktree already exists/);
  assert.deepEqual(run.calls.filter((call) => call.startsWith('worktree run-all')), ['worktree run-all alpha']);
  assert.equal(byName(run.report, 'alpha')?.merged, true);
});

test('apply-many: an existing worktree is resumed without being created again', { skip: !available }, () => {
  const root = mkdtempSync(join(work, 'p-'));
  mkdirSync(join(root, '.worktrees', 'alpha', '.awf', 'status'), { recursive: true });
  const run = applyMany('alpha', {}, root);

  assert.deepEqual(run.calls.filter((call) => call.startsWith('worktree create')), []);
  assert.deepEqual(run.calls.filter((call) => call.startsWith('worktree run-all')), ['worktree run-all alpha']);
  assert.equal(byName(run.report, 'alpha')?.created, true);
  assert.equal(byName(run.report, 'alpha')?.merged, true);
});

test('apply-many: without a merge, the end-to-end tests do not run', { skip: !available }, () => {
  const run = applyMany('bad-one');

  assert.ok(!run.calls.includes('e2e'));
  assert.equal(run.report?.e2e, 'skipped');
});

test('apply-many: an invalid change name stops everything before commands.sh is called', { skip: !available }, () => {
  const run = applyMany('alpha ;touch-pwned');

  assert.deepEqual(run.calls, []);
  assert.match(run.output, /is not valid/);
  assert.notEqual(run.status, 0);
});

test('apply-many: an invalid parallelism setting stops the run before any call to commands.sh', { skip: !available }, () => {
  for (const [name, value] of [['max_changes', '0'], ['max', '0'], ['max_tasks', 'many'], ['max_total', '-1']] as const) {
    const run = applyMany('alpha', { [name]: value });

    assert.deepEqual(run.calls, [], name);
    assert.match(run.output, /integer of 1 or more/, name);
    assert.notEqual(run.status, 0, name);
  }
});

test('apply-many: the report is in the run directory, copied to the last report, with its identifier', { skip: !available }, () => {
  const run = applyMany('alpha', { run_id: 'trial-1' });

  assert.equal(run.report?.status, 'done');
  assert.equal((run.report as unknown as { run_id: string }).run_id, 'trial-1');
  assert.ok(existsSync(join(run.root, '.awf/status/apply-many/trial-1/apply-many.json')));
  assert.ok(existsSync(join(run.root, '.awf/status/apply-many/trial-1/alpha.json')));
  assert.match((run.report as unknown as { e2e_note: string }).e2e_note, /other runs/);
});

test('apply-many: without a given identifier, one is created (timestamp and suffix), and the phases find it again', { skip: !available }, () => {
  const run = applyMany('alpha');

  const id = (run.report as unknown as { run_id: string }).run_id;
  assert.match(id, /^\d{8}T\d{6}-[0-9a-f]{6}$/);
  assert.ok(existsSync(join(run.root, '.awf/status/apply-many', id, 'apply-many.json')));
});

test('apply-many: the change is claimed before anything is created and released at the end', { skip: !available }, () => {
  const run = applyMany('alpha beta', { run_id: 'trial-2' });

  assert.match(run.claims[0] ?? '', /^worktree claim --run trial-2 --pid \d+ alpha beta$/);
  assert.equal(run.claims.at(-1), 'worktree release --run trial-2 alpha beta');
});

test('apply-many: a change already held by another run stops everything before anything is created', { skip: !available }, () => {
  const run = applyMany('alpha held', { run_id: 'trial-3' });

  assert.notEqual(run.status, 0);
  assert.deepEqual(run.calls, []);
  assert.match(run.output, /is applying the change held/);
  assert.match(run.output, /Wait for it to finish/);
});

test('apply-many: two runs in the same repository each keep their report, the last one written is copied to the root', { skip: !available }, () => {
  const first = applyMany('alpha', { run_id: 'run-a' });
  const second = applyMany('beta', { run_id: 'run-b' }, first.root);

  assert.ok(existsSync(join(first.root, '.awf/status/apply-many/run-a/apply-many.json')));
  assert.ok(existsSync(join(first.root, '.awf/status/apply-many/run-b/apply-many.json')));
  assert.equal((second.report as unknown as { run_id: string }).run_id, 'run-b');
  assert.deepEqual(JSON.parse(readFileSync(join(first.root, '.awf/status/apply-many/run-a/apply-many.json'), 'utf8')).changes.map((c: { change: string }) => c.change), ['alpha']);
});
