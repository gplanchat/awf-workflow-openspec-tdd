// Timeouts of the sub-workflow calls: awf stops a call_workflow without an explicit timeout after 5 minutes.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const MINIMUM = 28_800; // 8 hours: a full review fits in a sub-workflow with room to spare

/** The `call_workflow` states of a workflow: name and text block (states are indented by two spaces). */
function subWorkflowCalls(text: string): { state: string; block: string }[] {
  const blocks = text.split(/^(?=  [A-Za-z_][\w-]*:\s*$)/m);
  return blocks
    .filter((block) => /^ {4}type:\s*call_workflow\s*$/m.test(block))
    .map((block) => ({ state: block.match(/^ {2}([\w-]+):/)?.[1] ?? '?', block }));
}

const stateBlock = (file: string, state: string) => readFileSync(join(WORKFLOWS, file), 'utf8').split(/^(?=  [A-Za-z_][\w-]*:\s*$)/m).find((b) => b.startsWith(`  ${state}:`)) ?? '';

test('every sub-workflow call has an explicit timeout of at least 8 hours', () => {
  const faults: string[] = [];
  let calls = 0;
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yaml'))) {
    for (const { state, block } of subWorkflowCalls(readFileSync(join(WORKFLOWS, file), 'utf8'))) {
      calls += 1;
      const timeout = Number(block.match(/^ {4}timeout:\s*(\d+)\s*$/m)?.[1] ?? 0);
      if (timeout < MINIMUM) faults.push(`${file}, state ${state}`);
    }
  }

  assert.ok(existsSync(join(WORKFLOWS, 'tdd-slice-threejs.yaml')), 'the threejs slice also calls its review');
  assert.ok(calls >= 3, 'the test must see the calls of apply-change and apply-task');
  assert.deepEqual(faults, [], 'Add "timeout: 28800" to these states: awf stops a sub-workflow without an explicit timeout after 5 minutes.');
});

test('the block reader finds a call without a timeout', () => {
  const example = 'states:\n  initial: a\n  a:\n    type: call_workflow\n    workflow: b\n    on_success: done\n  done:\n    type: terminal\n';
  const calls = subWorkflowCalls(example);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.state, 'a');
  assert.doesNotMatch(calls[0]?.block ?? '', /timeout/);
});

test('the check state of review, which also runs mutation testing, the capture and the budget, lets mutation testing finish', () => {
  const timeout = Number(stateBlock('review.yaml', 'check').match(/^ {4}timeout:\s*(\d+)\s*$/m)?.[1] ?? 0);

  assert.ok(timeout >= 7_200, `review.yaml check: ${String(timeout)} s. A review cut during mutation testing leaves instrumented files behind and fails the linters of the next review.`);
});

test('slice_base and commit_slice of apply-task are command states, with no sub-workflow call to bound', () => {
  for (const state of ['slice_base', 'commit_slice']) assert.match(stateBlock('apply-task.yaml', state), /^ {4}type: step$/m, state);
  assert.deepEqual(
    subWorkflowCalls(readFileSync(join(WORKFLOWS, 'apply-task.yaml'), 'utf8')).map(({ state }) => state),
    ['run_php', 'run_ts', 'run_threejs', 'run_go', 'run_rust', 'run_rust_perf', 'run_free', 'run_manual'],
  );
});

test('the review called with a base, and the final review without a base, keep their 8-hour timeout', () => {
  for (const [file, state, base] of [
    ['tdd-slice-php.yaml', 'review', true], ['tdd-slice-ts.yaml', 'review', true],
    ['tdd-slice-php.yaml', 'review_resume', true], ['tdd-slice-ts.yaml', 'review_resume', true],
    ['apply-change.yaml', 'final_review', false],
  ] as const) {
    const call = subWorkflowCalls(readFileSync(join(WORKFLOWS, file), 'utf8')).find((c) => c.state === state);
    assert.ok(call, `${file} ${state}`);
    assert.equal(/^ {6}base: /m.test(call.block), base, `${file} ${state}`);
    assert.equal(Number(call.block.match(/^ {4}timeout:\s*(\d+)\s*$/m)?.[1] ?? 0), MINIMUM, `${file} ${state}`);
  }
});

test('the resumed review receives resume, the final review of apply-change does not', () => {
  for (const [file, state, resume] of [
    ['tdd-slice-php.yaml', 'review', false], ['tdd-slice-ts.yaml', 'review', false],
    ['tdd-slice-php.yaml', 'review_resume', true], ['tdd-slice-ts.yaml', 'review_resume', true],
    ['apply-change.yaml', 'final_review', false],
  ] as const) {
    const call = subWorkflowCalls(readFileSync(join(WORKFLOWS, file), 'utf8')).find((c) => c.state === state);
    assert.ok(call, `${file} ${state}`);
    assert.equal(/^ {6}resume: /m.test(call.block), resume, `${file} ${state}`);
  }
});

test('tools and resume are command states, with no sub-workflow call to bound', () => {
  for (const [file, state] of [['review.yaml', 'tools'], ['tdd-slice-php.yaml', 'resume'], ['tdd-slice-ts.yaml', 'resume']] as const) {
    assert.match(stateBlock(file, state), /^ {4}type: step$/m, `${file} ${state}`);
  }
});
