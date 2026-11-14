// Flow control of apply-change.yaml, tried with awf on a throwaway project. The real tdd-slice and free-task workflows
// (which start agents) are replaced by doubles that log their input and fail on demand.
// The tests are skipped when awf is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const AWF = spawnSync('awf', ['--help'], { encoding: 'utf8' });
const available = AWF.status === 0;
const AWF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'apply-change-'));
after(() => rmSync(work, { recursive: true, force: true }));

const STUB = (name: string, extra: string) => `name: ${name}
version: "0.0.1"
inputs:
  - name: change
    type: string
    required: true
  - name: slice
    type: string
    required: true
  - name: hexagon
    type: string
    required: true
  - name: agent
    type: string
    default: claude
states:
  initial: run
  run:
    type: step
    command: |
      slice=$(cat <<'AWF_SLICE_END'
      {{.inputs.slice}}
      AWF_SLICE_END
      )
      printf '%s|%s|%s\\n' '${name}' '{{.inputs.hexagon}}' "$slice" >> calls.log
      ${extra}
    on_success: done
    on_failure: {message: "double failed", status: 20}
  done:
    type: terminal
    status: success
`;

const FAIL_ON_MARK = 'case "$slice" in *FAILING*) printf \'{"phase":"review","hexagon":"{{.inputs.hexagon}}","code":30,"message":"review failed"}\\n\' > .awf/status/tdd-slice.json; exit 1;; esac';

// commands.sh replaced through WORKTREE_BIN: settings returns the resolved settings (option, then FLOW_MAX_*, then the
// defaults); run-tasks logs its arguments and simulates the sub-worktrees: the tasks whose number is in WORKTREE_FAIL
// fail, the others are checked in tasks.md (the merge of the sub-branches) and the report .awf/status/run-tasks.json is
// written.
const FAKE_WT = `#!/usr/bin/env bash
cmd=$1; shift
echo "worktree $cmd $*" >> worktree.log
case "$cmd" in
  settings)
    t=\${FLOW_MAX_TASKS:-1}; g=\${FLOW_MAX_TOTAL:-3}
    while [[ $# -gt 0 ]]; do
      case "$1" in --max-tasks) t=$2 ;; --max-total) g=$2 ;; esac
      shift 2
    done
    for v in "$t" "$g"; do [[ $v =~ ^[1-9][0-9]*$ ]] || { echo "The setting \\"$v\\" is not valid: give an integer of 1 or more." >&2; exit 2; }; done
    echo "{\\"max_changes\\":2,\\"max_tasks\\":$t,\\"max_total\\":$g}" ;;
  run-tasks)
    change=$1; shift 1
    while [[ $1 == --max-* ]]; do shift 2; done
    ok=true; json=""
    for id in "$@"; do
      if [[ " \${WORKTREE_FAIL:-} " == *" $id "* ]]; then json+="\\"$id\\":{\\"status\\":\\"failed\\",\\"merged\\":false},"; ok=false
      else
        sed -i "s/^- \\[ \\] $id /- [x] $id /" "openspec/changes/$change/tasks.md"
        json+="\\"$id\\":{\\"status\\":\\"done\\",\\"merged\\":true},"
      fi
    done
    mkdir -p .awf/status
    echo "{\\"tasks\\":{\${json%,}},\\"status\\":\\"$([[ $ok == true ]] && echo done || echo failed)\\"}" > .awf/status/run-tasks.json
    [[ $ok == true ]] ;;
esac
`;

const GIT_IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function project(tasks: string): string {
  const root = mkdtempSync(join(work, 'p-'));
  mkdirSync(join(root, '.awf', 'workflows'), { recursive: true });
  mkdirSync(join(root, '.awf', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'changes', 'demo'), { recursive: true });
  for (const workflow of ['apply-change.yaml', 'apply-task.yaml', 'dod-verify.yaml', 'review.yaml']) cpSync(join(AWF_DIR, 'workflows', workflow), join(root, '.awf', 'workflows', workflow));
  writeFileSync(join(root, 'fake-worktree'), FAKE_WT, { mode: 0o755 });
  for (const script of ['openspec-tasks.sh', 'commands.sh', 'openspec-tasks.mts', 'tdd-gate.sh', 'review-slots.sh', 'review-languages.sh']) cpSync(join(AWF_DIR, 'scripts', script), join(root, '.awf', 'scripts', script));
  // The php REVIEW creates a test database: a fake database script avoids a real one.
  writeFileSync(join(root, '.awf', 'scripts', 'test-database.sh'), 'case $1 in url) echo postgresql://fake;; esac\n');
  for (const name of ['tdd-slice-php', 'tdd-slice-ts', 'tdd-slice-threejs', 'tdd-slice-go', 'tdd-slice-rust', 'tdd-slice-rust-perf']) writeFileSync(join(root, '.awf', 'workflows', `${name}.yaml`), STUB(name, FAIL_ON_MARK));
  cpSync(join(AWF_DIR, 'scripts', 'fixtures', 'project', '.awf', 'languages.yaml'), join(root, '.awf', 'languages.yaml'));
  writeFileSync(join(root, '.awf', 'workflows', 'free-task.yaml'), STUB('free-task', FAIL_ON_MARK));
  writeFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), tasks);
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function apply(root: string, inputs: Record<string, string> = {}, env: Record<string, string> = {}) {
  const result = spawnSync('awf', ['run', 'apply-change', '--output', 'buffered', '--input', 'change=demo', ...Object.entries(inputs).flatMap(([name, value]) => ['--input', `${name}=${value}`])], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY, TDD_CHECK_CMD: 'true', WORKTREE_BIN: './fake-worktree', ...env },
  });
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: read('calls.log').split('\n').filter((line) => line !== ''),
    worktree: read('worktree.log').split('\n').filter((line) => line !== ''),
    tasks: read('openspec/changes/demo/tasks.md'),
    report: JSON.parse(read('.awf/status/apply-change.json') || 'null') as { change: string; done: string[]; failed: { id: string; phase: string | null; status: number | null } | null; status: string } | null,
  };
}

const TASKS = `## 1. API foundation

- [ ] 1.1 DBAL repository \`OrderRepository\`
  - [ ] 1.1.1 [php] DBAL repository \`OrderRepository\`
- [ ] 1.2 REVIEW of the foundation
- [ ] 1.3 DBAL repository \`InvoiceRepository\` FAILING
  - [ ] 1.3.1 [php] DBAL repository \`InvoiceRepository\` FAILING

## 2. Compliance

- [ ] 2.1 README: walkthrough. Verified by: \`true\`
`;

test('apply-change: a slice, a manual task, a REVIEW, in order, everything checked', { skip: !available }, () => {
  const root = project(TASKS.replaceAll(' FAILING', ''));
  const run = apply(root);

  assert.deepEqual(run.calls, ['tdd-slice-php|php|1.1.1 DBAL repository `OrderRepository`', 'tdd-slice-php|php|1.3.1 DBAL repository `InvoiceRepository`', 'free-task|docs|2.1 README: walkthrough. Verified by: `true`']);
  assert.equal(run.tasks.split('\n').filter((line) => line.startsWith('- [ ]')).length, 0);
  assert.deepEqual(run.report, { change: 'demo', done: ['1.1', '1.3', '2.1'], skipped: [], failed: null, status: 'done' });
  assert.equal(run.status, 0);
});

test('apply-change: a manual task without a "Verified by" command stays open and the report lists it as skipped', { skip: !available }, () => {
  const root = project(TASKS.replaceAll(' FAILING', '').replace('Verified by: `true`', 'vérifier par une relecture'));
  const run = apply(root);

  assert.match(run.tasks, /- \[ \] 2\.1 /);
  assert.deepEqual((run.report as { skipped?: string[] } | null)?.skipped, ['2.1']);
  assert.match(run.output, /Tasks left open, their box unchecked: 2\.1/);
});

test('apply-change: stops at the first failed task, does not check it and names the phase', { skip: !available }, () => {
  const root = project(TASKS);
  const run = apply(root);

  assert.deepEqual(run.calls.map((call) => call.split('|')[0]), ['tdd-slice-php', 'tdd-slice-php']);
  assert.match(run.tasks, /- \[x\] 1\.1 /);
  assert.match(run.tasks, /- \[ \] 1\.3 /);
  assert.match(run.tasks, /- \[ \] 1\.2 REVIEW/);
  assert.match(run.tasks, /- \[ \] 2\.1 /);
  assert.deepEqual(run.report, { change: 'demo', done: ['1.1'], skipped: [], failed: { id: '1.3', phase: 'review', status: 30 }, status: 'failed' });
  assert.notEqual(run.status, 0);
});

test('apply-change: a new run starts from the first open task', { skip: !available }, () => {
  const root = project(TASKS);
  apply(root);
  writeFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8').replaceAll(' FAILING', ''));
  rmSync(join(root, 'calls.log'));

  const run = apply(root);

  assert.deepEqual(run.calls.map((call) => call.split('|')[2]?.slice(0, 3)), ['1.3', '2.1']);
  assert.deepEqual(run.report?.done, ['1.3', '2.1']);
  assert.equal(run.report?.status, 'done');
});

test('apply-change: a lone REVIEW is checked by the final review', { skip: !available }, () => {
  const root = project('## 1. Remaining\n\n- [ ] 1.1 REVIEW of `pwa/` at the thresholds\n');
  const run = apply(root);

  assert.deepEqual(run.calls, []);
  assert.match(run.tasks, /- \[x\] 1\.1 REVIEW/);
  assert.equal(run.report?.status, 'done');
});

test('apply-change: a failed final review leaves the REVIEW tasks open and says so', { skip: !available }, () => {
  const root = project('## 1. API foundation\n\n- [ ] 1.1 DBAL repository `A`\n  - [ ] 1.1.1 [php] DBAL repository `A`\n- [ ] 1.2 REVIEW of the foundation\n');
  const result = spawnSync('awf', ['run', 'apply-change', '--output', 'buffered', '--input', 'change=demo'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WORKTREE_BIN: './fake-worktree', TDD_CHECK_CMD: 'echo "src/A.php:3 error"; exit 1' },
  });
  const tasks = readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8');
  const report = JSON.parse(readFileSync(join(root, '.awf', 'status', 'apply-change.json'), 'utf8')) as { failed: { id: string; phase: string; status: number }; status: string };

  assert.notEqual(result.status, 0);
  assert.match(tasks, /- \[x\] 1\.1 /);
  assert.match(tasks, /- \[ \] 1\.2 REVIEW/);
  assert.deepEqual(report, { ...report, status: 'failed', failed: { id: 'final-review', phase: 'check', status: 30 } });
});

test('apply-change: a [threejs] slice gets the threejs final review, and a failed review says so', { skip: !available }, () => {
  const tasks = '## 1. Rendering\n\n- [ ] 1.1 Arch `pwa/`\n  - [ ] 1.1.1 [threejs] Arch `pwa/`\n- [ ] 1.2 REVIEW of the rendering\n';
  const run = (check: string) => {
    const root = project(tasks);
    const result = spawnSync('awf', ['run', 'apply-change', '--output', 'buffered', '--input', 'change=demo'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, WORKTREE_BIN: './fake-worktree', TDD_CHECK_CMD: check },
    });
    return { root, status: result.status, log: readFileSync(join(root, 'calls.log'), 'utf8'), tasks: readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8') };
  };

  const ok = run('true');
  assert.equal(ok.status, 0);
  assert.match(ok.log, /tdd-slice-threejs\|threejs\|1\.1\.1/);
  assert.match(ok.tasks, /- \[x\] 1\.2 REVIEW/);

  const ko = run('echo "capture: mismatch"; exit 1');
  assert.notEqual(ko.status, 0);
  assert.match(ko.tasks, /- \[ \] 1\.2 REVIEW/);
});

const PARALLEL = `## 1. API foundation

- [ ] 1.1 DBAL repository \`A\`
  - [ ] 1.1.1 [php] DBAL repository \`A\`

## 2. Rendering (parallel)

- [ ] 2.1 Component \`pwa/\` A
  - [ ] 2.1.1 [ts] Component \`pwa/\` A
- [ ] 2.2 Component \`pwa/\` B
  - [ ] 2.2.1 [ts] Component \`pwa/\` B
- [ ] 2.3 Component \`pwa/\` C
  - [ ] 2.3.1 [ts] Component \`pwa/\` C

## 3. Compliance

- [ ] 3.1 README: walkthrough. Verified by: \`true\`
`;

const sliceCalls = (calls: string[]) => calls;
const wtCalls = (worktree: string[]) => worktree.filter((call) => call.startsWith('worktree run-tasks'));

test('apply-change: a (parallel) group with the default max_tasks runs sequentially, run-tasks is not called', { skip: !available }, () => {
  const run = apply(project(PARALLEL));

  assert.deepEqual(wtCalls(run.worktree), []);
  assert.deepEqual(sliceCalls(run.calls).map((call) => call.split('|')[2]?.slice(0, 3)), ['1.1', '2.1', '2.2', '2.3', '3.1']);
  assert.deepEqual(run.report, { change: 'demo', done: ['1.1', '2.1', '2.2', '2.3', '3.1'], skipped: [], failed: null, status: 'done' });
});

test('apply-change: max_tasks 2, the marked group goes in one call to commands.sh run-tasks with the right numbers and settings', { skip: !available }, () => {
  const run = apply(project(PARALLEL), { max_tasks: '2', max_total: '4' });

  assert.deepEqual(wtCalls(run.worktree), ['worktree run-tasks demo --max-tasks 2 --max-total 4 2.1 2.2 2.3']);
  assert.deepEqual(sliceCalls(run.calls).map((call) => call.split('|')[2]?.slice(0, 3)), ['1.1', '3.1']);
  assert.deepEqual(run.report, { change: 'demo', done: ['1.1', '2.1', '2.2', '2.3', '3.1'], skipped: [], failed: null, status: 'done' });
  assert.equal(run.tasks.split('\n').filter((line) => line.startsWith('- [ ]')).length, 0);
  assert.equal(run.status, 0);
});

test('apply-change: a group without the marker stays sequential even with max_tasks 3', { skip: !available }, () => {
  const run = apply(project(PARALLEL.replaceAll(' (parallel)', '')), { max_tasks: '3' });

  assert.deepEqual(wtCalls(run.worktree), []);
  assert.equal(run.report?.status, 'done');
});

test('apply-change: the settings come from the environment when the inputs are empty', { skip: !available }, () => {
  const run = apply(project(PARALLEL), {}, { FLOW_MAX_TASKS: '3', FLOW_MAX_TOTAL: '5' });

  assert.deepEqual(wtCalls(run.worktree), ['worktree run-tasks demo --max-tasks 3 --max-total 5 2.1 2.2 2.3']);
});

test('apply-change: an invalid setting stops everything before the first task', { skip: !available }, () => {
  const run = apply(project(PARALLEL), { max_tasks: '0' });

  assert.deepEqual(sliceCalls(run.calls), []);
  assert.deepEqual(wtCalls(run.worktree), []);
  assert.match(run.output, /integer of 1 or more/);
  assert.notEqual(run.status, 0);
});

test('apply-change: a task of a parallel batch fails, the others are merged and checked, the report names the failed task', { skip: !available }, () => {
  const run = apply(project(PARALLEL), { max_tasks: '2' }, { WORKTREE_FAIL: '2.2' });

  assert.match(run.tasks, /- \[x\] 2\.1 /);
  assert.match(run.tasks, /- \[ \] 2\.2 /);
  assert.match(run.tasks, /- \[x\] 2\.3 /);
  assert.match(run.tasks, /- \[ \] 3\.1 /);
  assert.deepEqual(sliceCalls(run.calls).map((call) => call.split('|')[2]?.slice(0, 3)), ['1.1']);
  assert.deepEqual(run.report, { change: 'demo', done: ['1.1', '2.1', '2.3'], skipped: [], failed: { id: '2.2', phase: 'parallel', status: null }, status: 'failed' });
  assert.notEqual(run.status, 0);
});

test('apply-change: after a failed parallel batch, the lone task runs again sequentially, then the rest', { skip: !available }, () => {
  const root = project(PARALLEL);
  apply(root, { max_tasks: '2' }, { WORKTREE_FAIL: '2.2' });
  rmSync(join(root, 'calls.log'));
  rmSync(join(root, 'worktree.log'));

  const run = apply(root, { max_tasks: '2' });

  assert.deepEqual(wtCalls(run.worktree), []);
  assert.deepEqual(sliceCalls(run.calls).map((call) => call.split('|')[2]?.slice(0, 3)), ['2.2', '3.1']);
  assert.deepEqual(run.report, { change: 'demo', done: ['2.2', '3.1'], skipped: [], failed: null, status: 'done' });
});

test('apply-change: a sequential failure before the parallel batch prevents run-tasks', { skip: !available }, () => {
  const run = apply(project(PARALLEL.replaceAll('DBAL repository `A`', 'DBAL repository `A` FAILING')), { max_tasks: '2' });

  assert.deepEqual(wtCalls(run.worktree), []);
  assert.deepEqual(run.report?.failed, { id: '1.1', phase: 'review', status: 30 });
});

test('apply-task: a slice goes through tdd-slice and is checked in the current directory, a REVIEW is skipped', { skip: !available }, () => {
  const root = project(PARALLEL.replaceAll('3.1 README', '3.1 REVIEW of the foundation'));
  const run = (task: string) => spawnSync('awf', ['run', 'apply-task', '--output', 'buffered', '--input', 'change=demo', '--input', `task=${task}`], { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY, TDD_CHECK_CMD: 'true' } });
  const report = () => JSON.parse(readFileSync(join(root, '.awf', 'status', 'apply-task.json'), 'utf8')) as { task: string; status: string; failed: unknown };
  const tasks = () => readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8');

  assert.equal(run('2.1').status, 0);
  assert.deepEqual(report(), { change: 'demo', task: '2.1', status: 'done', failed: null, slices: [{ id: '2.1.1', language: 'ts', status: 'done', failed: null }] });
  assert.match(tasks(), /- \[x\] 2\.1 /);
  assert.match(readFileSync(join(root, 'calls.log'), 'utf8'), /tdd-slice-ts\|ts\|2\.1\.1 /);

  assert.equal(run('3.1').status, 0);
  assert.equal(report().status, 'skipped');
  assert.match(tasks(), /- \[ \] 3\.1 REVIEW/);
});

test('apply-task: the text of a slice may hold an apostrophe, it reaches tdd-slice intact', { skip: !available }, () => {
  const root = project('## 1. Foundation\n\n- [ ] 1.1 Check the caller\'s order\n  - [ ] 1.1.1 [ts] Check the caller\'s order\n');
  const run = spawnSync('awf', ['run', 'apply-task', '--output', 'buffered', '--input', 'change=demo', '--input', 'task=1.1'], { cwd: root, encoding: 'utf8', env: { ...process.env, TDD_CHECK_CMD: 'true' } });

  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(readFileSync(join(root, 'calls.log'), 'utf8'), /tdd-slice-ts\|ts\|1\.1\.1 Check the caller's order/);
  assert.match(readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[x\] 1\.1 /);
});

test('apply-task: a failed gate leaves the task open and names the phase',{ skip: !available }, () => {
  const root = project(PARALLEL.replaceAll('Component `pwa/` B', 'Component `pwa/` FAILING B'));
  const result = spawnSync('awf', ['run', 'apply-task', '--output', 'buffered', '--input', 'change=demo', '--input', 'task=2.2'], { cwd: root, encoding: 'utf8', env: { ...process.env, TDD_CHECK_CMD: 'true' } });

  assert.notEqual(result.status, 0);
  assert.match(readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[ \] 2\.2 /);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.awf', 'status', 'apply-task.json'), 'utf8')), { change: 'demo', task: '2.2', status: 'failed', failed: { phase: 'review', status: 30 }, slices: [{ id: '2.2.1', language: 'ts', status: 'failed', failed: { phase: 'review', status: 30 } }] });
});

test('apply-task: a manual task goes through free-task', { skip: !available }, () => {
  const root = project(PARALLEL);
  const result = spawnSync('awf', ['run', 'apply-task', '--output', 'buffered', '--input', 'change=demo', '--input', 'task=3.1'], { cwd: root, encoding: 'utf8', env: { ...process.env, TDD_CHECK_CMD: 'true' } });

  assert.equal(result.status, 0);
  assert.match(readFileSync(join(root, 'calls.log'), 'utf8'), /free-task\|docs\|3\.1 /);
});

const DOD_TASKS = (command: string) => `## Definition of Done

- [ ] D1 The file exists. Verified by: \`test -f marker.txt\`
- [ ] D2 Command under test. Verified by: \`${command}\`
- [ ] D3 Human review

## 1. API foundation

- [ ] 1.1 DBAL repository \`A\`
  - [ ] 1.1.1 [php] DBAL repository \`A\`
- [ ] 1.2 REVIEW of the foundation
`;

test('apply-change: the final review checks the Definition of Done, checks the criteria that pass and leaves those without a command', { skip: !available }, () => {
  const root = project(DOD_TASKS('true'));
  writeFileSync(join(root, 'marker.txt'), '');
  const run = apply(root);

  assert.match(run.tasks, /- \[x\] D1 /);
  assert.match(run.tasks, /- \[x\] D2 /);
  assert.match(run.tasks, /- \[ \] D3 /);
  assert.match(run.tasks, /- \[x\] 1\.2 REVIEW/);
  assert.deepEqual((run.report as { dod?: unknown } | null)?.dod, { checked: ['D1', 'D2'], failed: null, manual: ['D3'] });
  assert.equal(run.status, 0);
});

test('apply-change: a failed Definition of Done criterion stops the workflow, names the criterion and leaves the REVIEW tasks open', { skip: !available }, () => {
  const root = project(DOD_TASKS('echo raw-output; exit 1'));
  writeFileSync(join(root, 'marker.txt'), '');
  const run = apply(root);

  assert.notEqual(run.status, 0);
  assert.match(run.tasks, /- \[x\] D1 /);
  assert.match(run.tasks, /- \[ \] D2 /);
  assert.match(run.tasks, /- \[ \] 1\.2 REVIEW/);
  assert.deepEqual(run.report?.failed, { id: 'final-review', phase: 'review', status: 30 });
  assert.deepEqual((run.report as { dod?: unknown } | null)?.dod, { checked: ['D1'], failed: 'D2', manual: ['D3'] });
  assert.match(readFileSync(join(root, '.awf', 'status', 'review-last.txt'), 'utf8'), /raw-output/);
});

const dodProject = () => {
  const root = project('## Definition of Done\n\n- [ ] D1 First. Verified by: `true`\n- [ ] D2 Second. Verified by: `exit 1`\n- [ ] D3 Third. Verified by: `touch d3-ran`\n\n## 1. X\n\n- [ ] 1.1 REVIEW\n');
  const dod = (replay: string) => spawnSync('awf', ['run', 'dod-verify', '--output', 'buffered', '--input', 'change=demo', '--input', `replay=${replay}`], { cwd: root, encoding: 'utf8' });
  return { root, dod };
};

test('dod-verify: D2 fails, code 30 in the report, D3 does not run', { skip: !available }, () => {
  const { root, dod } = dodProject();
  const result = dod('false');
  const tasks = readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8');

  assert.notEqual(result.status, 0);
  assert.match(tasks, /- \[x\] D1 /);
  assert.match(tasks, /- \[ \] D2 /);
  assert.match(tasks, /- \[ \] D3 /);
  assert.equal(existsSync(join(root, 'd3-ran')), false);
  assert.equal((JSON.parse(readFileSync(join(root, '.awf', 'status', 'tdd-slice.json'), 'utf8')) as { code: number }).code, 30);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.awf', 'status', 'dod.json'), 'utf8')), { checked: ['D1'], failed: 'D2', manual: [] });
});

test('dod-verify: replay runs the checked criteria again without checking anything', { skip: !available }, () => {
  const { root, dod } = dodProject();
  const file = join(root, 'openspec', 'changes', 'demo', 'tasks.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('exit 1', 'true').replace('- [ ] D1', '- [x] D1'));
  const result = dod('true');

  assert.equal(result.status, 0);
  assert.equal(existsSync(join(root, 'd3-ran')), true);
  assert.match(readFileSync(file, 'utf8'), /- \[ \] D2 /);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.awf', 'status', 'dod.json'), 'utf8')), { checked: ['D1', 'D2', 'D3'], failed: null, manual: [] });
});

function applyTask(tasks: string, task: string, commit = 'true') {
  const root = project(tasks);
  const result = spawnSync('awf', ['run', 'apply-task', '--output', 'buffered', '--input', 'change=demo', '--input', `task=${task}`, '--input', `commit=${commit}`], { cwd: root, encoding: 'utf8', env: { ...process.env, TDD_CHECK_CMD: 'true' } });
  const file = (name: string) => readFileSync(join(root, name), 'utf8');
  const log = spawnSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter((line) => line !== '');
  return { status: result.status, log, tasks: file('openspec/changes/demo/tasks.md'), report: JSON.parse(file('.awf/status/apply-task.json')) as { status: string } };
}

test('apply-task: a failed "Verified by" command leaves the box open and the report failed', { skip: !available }, () => {
  const run = applyTask('## 1. X\n\n- [ ] 1.1 README. Verified by: `exit 1`\n', '1.1');

  assert.notEqual(run.status, 0);
  assert.match(run.tasks, /- \[ \] 1\.1 /);
  assert.equal(run.report.status, 'failed');
});

test('apply-task: a manual task without a command stays open, report skipped', { skip: !available }, () => {
  const run = applyTask('## 1. X\n\n- [ ] 1.1 README. Verified by: Manual\n', '1.1');

  assert.equal(run.status, 0);
  assert.match(run.tasks, /- \[ \] 1\.1 /);
  assert.equal(run.report.status, 'skipped');
});

test('apply-task: the checked task is committed, except with commit=false', { skip: !available }, () => {
  const tasks = '## 1. X\n\n- [ ] 1.1 README. Verified by: `true`\n';
  const committed = applyTask(tasks, '1.1');
  assert.equal(committed.status, 0);
  assert.deepEqual(committed.log, ['docs(demo): README.']);

  const skipped = applyTask(tasks, '1.1', 'false');
  assert.equal(skipped.status, 0);
  assert.deepEqual(skipped.log, []);
});
