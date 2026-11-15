// The chain apply-change -> apply-task -> tdd-slice-<language> -> review, and the Definition of Done, stays in
// call_workflow: an `awf run` inside a command step would start a nested awf process, outside the parent's journal.
// The YAML files are read as text (no dependency): a state is a key indented by two spaces under `states:`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

type State = { type: string; workflow?: string; body: string };

const states = (file: string): Map<string, State> => {
  const text = readFileSync(join(WORKFLOWS, `${file}.yaml`), 'utf8');
  const out = new Map<string, State>();
  let current: string | undefined;
  let inStates = false;
  for (const line of text.split('\n')) {
    if (/^states:/.test(line)) { inStates = true; continue; }
    if (!inStates) continue;
    const key = /^  ([a-z_]+):\s*$/.exec(line);
    if (key) { current = key[1]; out.set(current, { type: '', body: '' }); continue; }
    if (!current) continue;
    const state = out.get(current)!;
    state.body += `${line}\n`;
    state.type ||= /^    type: (\w+)/.exec(line)?.[1] ?? '';
    state.workflow ??= /^    workflow: (\S+)/.exec(line)?.[1];
  }
  return out;
};

const FILES = ['apply-change', 'apply-task', 'tdd-slice-php', 'tdd-slice-ts', 'tdd-slice-go', 'tdd-slice-threejs', 'tdd-slice-rust', 'tdd-slice-rust-perf', 'review'];

const CALLS: Record<string, Record<string, string>> = {
  'apply-change': { run_task: 'apply-task', final_review: 'review', dod: 'dod-verify' },
  'apply-task': { run_php: 'tdd-slice-php', run_ts: 'tdd-slice-ts', run_threejs: 'tdd-slice-threejs', run_go: 'tdd-slice-go', run_rust: 'tdd-slice-rust', run_rust_perf: 'tdd-slice-rust-perf', run_free: 'free-task', run_manual: 'free-task' },
  'tdd-slice-php': { review: 'review' },
  'tdd-slice-ts': { review: 'review' },
  'tdd-slice-go': { review: 'review' },
  'tdd-slice-threejs': { review: 'review' },
  'tdd-slice-rust': { review: 'review' },
  'tdd-slice-rust-perf': { review: 'review' },
};

for (const [file, calls] of Object.entries(CALLS)) {
  test(`${file}: task, slice, review and Definition of Done are call_workflow states`, () => {
    const all = states(file);
    for (const [name, workflow] of Object.entries(calls)) {
      const state = all.get(name);
      assert.ok(state, `${file}: state ${name} is missing`);
      assert.equal(state.type, 'call_workflow', `${file}: ${name} must be a call_workflow`);
      assert.equal(state.workflow, workflow, `${file}: ${name} must call ${workflow}`);
    }
  });
}

test('no command step runs awf run, except run_parallel', () => {
  for (const file of FILES) {
    for (const [name, state] of states(file)) {
      if (file === 'apply-change' && name === 'run_parallel') continue;
      const code = state.body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      assert.doesNotMatch(code, /\bawf\s+run\b/, `${file}: ${name} runs awf run`);
    }
  }
});

// One commit per slice and the mutation base: slice_base before the slice workflow, commit_slice after mark_slice, the
// base passed only to tdd-slice-php, ts, rust and rust-perf, and no base in the final review.
const loopBody = (): string[] => {
  const body = states('apply-task').get('slices')!.body.split(/^    body:\n/m)[1]!;
  return [...body.matchAll(/^      - ([a-z_]+)\n/gm)].map((m) => m[1]!);
};

test('apply-task: the loop body takes the base before the slice and commits after the check', () => {
  assert.deepEqual(loopBody(), [
    'slice_language', 'slice_critical', 'slice_level', 'slice_text', 'slice_base', 'slice_workflow', 'run_php', 'run_ts', 'run_threejs', 'run_go', 'run_rust', 'run_rust_perf', 'run_free',
    'mark_slice', 'commit_slice', 'slice_failed', 'slice_done',
  ]);
  const all = states('apply-task');
  const base = all.get('slice_base')!.body;
  assert.match(base, /if \[ "\{\{\.inputs\.commit\}\}" = true \]; then\n\s+git rev-parse HEAD/);
  assert.match(base, /on_success: slices\n/);
  assert.match(all.get('mark_slice')!.body, /on_success: commit_slice\n\s+on_failure: slice_failed\n/);
  const commit = all.get('commit_slice')!.body;
  assert.match(commit, /if \[ "\{\{\.inputs\.commit\}\}" = true \]; then\n\s+bash \{\{\.awf\.scripts_dir\}\}\/openspec-tasks\.sh commit-slice \{\{\.inputs\.change\}\} /);
  assert.match(commit, /on_success: slice_done\n\s+on_failure: slice_failed\n/);
});

test('apply-task: the slice base goes to tdd-slice-php, ts, rust and rust-perf, not to the other workflows', () => {
  const all = states('apply-task');
  for (const name of ['run_php', 'run_ts', 'run_rust', 'run_rust_perf']) assert.match(all.get(name)!.body, /^      base: "\{\{\.states\.slice_base\.Output\}\}"\n/m, name);
  for (const name of ['run_threejs', 'run_go', 'run_free', 'run_manual']) assert.doesNotMatch(all.get(name)!.body, /base/, name);
});

test('apply-change: the final review passes no base', () => {
  const all = states('apply-change');
  assert.match(all.get('final_review')!.body, /^    inputs:\n      change: "\{\{\.inputs\.change\}\}"\n      language: "\{\{\.loop\.Item\}\}"\n    on_success/m);
  assert.doesNotMatch(all.get('final_review')!.body, /base|slice/);
  assert.doesNotMatch(all.get('run_task')!.body, /base/);
});
