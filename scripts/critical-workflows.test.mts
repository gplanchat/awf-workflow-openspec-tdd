// Critical slices across the workflows: apply-task reads [critical] from the slice and passes it to every TDD slice
// workflow; each one checks the trace of the critical scenarios right after RED and passes the flag to every review
// call. Textual reading of the YAML (no dependency): a state is a key indented by two spaces under `states:`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const SLICES = ['php', 'ts', 'go', 'rust', 'rust-perf'];
const WITH_TRACE = ['php', 'ts', 'go', 'rust'];

const read = (file: string): string => readFileSync(join(WORKFLOWS, file), 'utf8');
const states = (file: string): string[] => [...read(file).split(/^states:\s*$/m)[1]!.matchAll(/^ {2}([a-z_]+):\s*$/gm)].map((m) => m[1]!);
const block = (file: string, name: string): string => read(file).split(new RegExp(`^ {2}${name}:\\n`, 'm'))[1]!.split(/^ {2}\S/m)[0]!;

/** The state that follows check_red on success, and the state check_trace leads to. */
const afterRed = (file: string): string => /on_success: (\w+)/.exec(block(file, 'check_red'))?.[1] ?? '';

test('apply-task passes the critical flag of the slice to every TDD slice workflow', () => {
  assert.match(block('apply-task.yaml', 'slice_critical'), /jq -j '\.critical \/\/ false'/);
  for (const name of ['run_php', 'run_ts', 'run_go', 'run_rust', 'run_rust_perf']) {
    assert.match(block('apply-task.yaml', name), /^ {6}critical: "\{\{\.states\.slice_critical\.Output\}\}"\n/m, name);
  }
});

test('each TDD slice workflow declares the critical input, "false" by default', () => {
  for (const language of SLICES) {
    const inputs = read(`tdd-slice-${language}.yaml`).split(/^states:/m)[0]!;
    assert.match(inputs, /^ {2}- name: critical\n {4}type: string\n {4}default: "false"\n/m, language);
  }
});

test('check_red leads to check_trace, which runs critical-trace.sh only for a critical slice, then goes on to GREEN', () => {
  for (const language of WITH_TRACE) {
    const file = `tdd-slice-${language}.yaml`;
    assert.equal(afterRed(file), 'check_trace', language);
    assert.equal(states(file).indexOf('check_trace'), states(file).indexOf('check_red') + 1, language);
    const trace = block(file, 'check_trace');
    assert.match(trace, /\[ '\{\{\.inputs\.critical\}\}' = true \] \|\| exit 0\n\s+bash \{\{\.awf\.scripts_dir\}\}\/critical-trace\.sh \{\{\.inputs\.change\}\} \{\{\.inputs\.hexagon\}\}\n/, language);
    const next = /on_success: (\w+)/.exec(trace)?.[1] ?? '';
    assert.equal(next, 'init_turns', language);
    assert.match(trace, /on_failure: \{message: "RED \(trace\)[^"]*", status: 11\}/, language);
  }
});

test('every call of the review workflow passes the critical flag and the change', () => {
  for (const language of SLICES) {
    const file = `tdd-slice-${language}.yaml`;
    const calls = read(file).split(/^(?=  [a-z_]+:\s*$)/m).filter((b) => /^ {4}workflow: review$/m.test(b));
    assert.ok(calls.length >= 1, language);
    for (const call of calls) {
      assert.match(call, /^ {6}critical: "\{\{\.inputs\.critical\}\}"$/m, `${language}: ${call.split('\n')[0]}`);
      assert.match(call, /^ {6}change: "\{\{\.inputs\.change\}\}"$/m, `${language}: ${call.split('\n')[0]}`);
    }
  }
});

test('the review workflow adds critical_steps then required for a critical slice and passes TDD_CRITICAL to the gate', () => {
  const review = read('review.yaml');
  assert.match(review, /if \$c == "true" then \(\.critical_steps \/\/ \[\]\) \+ \(\.required \/\/ \[\]\)/);
  assert.match(review, /critical=0; \[ '\{\{\.inputs\.critical\}\}' = true \] && critical=1/);
  assert.match(review, /TDD_CRITICAL=\$critical/);
});
