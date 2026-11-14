// Shape of the tdd-slice-<language> workflows and of the shared review: state names, order and transitions.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

/** Names of the states of a workflow (keys indented by two spaces under `states:`), in file order. */
function states(file: string): string[] {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  return [...text.split(/^states:\s*$/m)[1]!.matchAll(/^ {2}([a-z_]+):\s*$/gm)].map((m) => m[1]!);
}

const blockOf = (file: string, state: string): string => readFileSync(join(WORKFLOWS, file), 'utf8').split(new RegExp(`^ {2}${state}:\\n`, 'm'))[1]!.split(/^ {2}\S/m)[0]!;

// threejs has no critical trace; php, ts and go check it right after RED.
const SKELETON = [
  'red', 'check_red', 'init_turns', 'green', 'check_green', 'green_turn', 'green_failed', 'review', 'classify',
  'back_to_red', 'check_back_to_red', 'back_to_green', 'agent_failed', 'stop', 'done',
];
const withTrace = (skeleton: string[]): string[] => skeleton.flatMap((s) => (s === 'check_red' ? [s, 'check_trace'] : [s]));

// php and ts have mutation testing: after going back to RED, their review can resume there (resume, review_resume).
const RESUME = ['resume', 'review_resume'];
const withResume = (skeleton: string[]): string[] => skeleton.flatMap((s) => (s === 'check_back_to_red' ? [s, ...RESUME] : [s]));

// In PHP, check_green is followed by two failure states: code 50 (test database unavailable) and the other codes.
const SKELETON_PHP = withResume(withTrace(SKELETON)).flatMap((s) => {
  if (s === 'check_green') return [s, 'database_unavailable'];
  if (s === 'review') return [s, 'route_review', 'review_database_unavailable'];
  return [s];
});

test('each tdd-slice-<language> follows the same skeleton', () => {
  assert.deepEqual(states('tdd-slice-php.yaml'), SKELETON_PHP);
  assert.deepEqual(states('tdd-slice-ts.yaml'), withResume(withTrace(SKELETON)));
  assert.deepEqual(states('tdd-slice-go.yaml'), withTrace(SKELETON));
  assert.ok(existsSync(join(WORKFLOWS, 'tdd-slice-ts.yaml')));
});

test('each tdd-slice-<language> calls the shared review with its language', () => {
  for (const language of ['ts', 'php', 'go', 'threejs', 'rust', 'rust-perf']) {
    const review = blockOf(`tdd-slice-${language}.yaml`, 'review');
    assert.match(review, /workflow: review\n/, language);
    assert.match(review, /language: "\{\{\.inputs\.hexagon\}\}"\n/, language);
  }
});

test('review reads its tools in the registry and runs them one by one', () => {
  assert.deepEqual(states('review.yaml'), ['tools', 'checks', 'check', 'check_failed', 'tool_failed', 'capture_failed', 'done']);
  const block = (state: string) => blockOf('review.yaml', state);
  assert.match(block('tools'), /openspec-tasks\.sh languages/);
  assert.match(block('tools'), /\.review_steps \/\/ \[\]\) \+ \(if \$c == "true" then \(\.critical_steps \/\/ \[\]\) \+ \(\.required \/\/ \[\]\)/);
  assert.match(block('tools'), /index\(\$r\) as \$i/);
  assert.match(block('checks'), /type: for_each\n\s+items: "\{\{\.states\.tools\.Output\}\}"/);
  assert.match(block('check'), /bash \{\{\.awf\.scripts_dir\}\}\/tdd-gate\.sh check '\{\{\.inputs\.language\}\}' \{\{\.loop\.Item\}\}\n/);
  for (const name of ['TDD_LAST', 'TDD_CRITICAL', 'TDD_BASE', 'TDD_SLICE', 'TDD_CHANGE']) assert.match(block('check'), new RegExp(`${name}=`), name);
});

const SKELETON_THREEJS = [...SKELETON.slice(0, -3), 'art_direction', ...SKELETON.slice(-3)];

test('tdd-slice-threejs has the skeleton plus art_direction', () => {
  assert.deepEqual(states('tdd-slice-threejs.yaml'), SKELETON_THREEJS);
});

test('tdd-slice-threejs calls review, targets the threejs registry entry and routes art-direction to a terminal state', () => {
  const text = readFileSync(join(WORKFLOWS, 'tdd-slice-threejs.yaml'), 'utf8');
  assert.match(text, /workflow: review\n/);
  assert.match(text, /name: hexagon\n\s+type: string\n\s+default: threejs\b/);
  assert.match(text, /art_direction:\n\s+type: terminal\n\s+status: failure/);
  assert.match(blockOf('tdd-slice-threejs.yaml', 'classify'), /contains "art-direction"'\n\s+goto: art_direction\n/);
});

test('tdd-slice-php sets TDD_CHANGE and TDD_SLICE before green and routes code 50 without an agent', () => {
  const text = readFileSync(join(WORKFLOWS, 'tdd-slice-php.yaml'), 'utf8');
  const check = blockOf('tdd-slice-php.yaml', 'check_green');
  assert.match(check, /TDD_SLICE=\$\(cat <<'FIN_TRANCHE'\n\s+\{\{\.inputs\.slice\}\}\n\s+FIN_TRANCHE\n\s+\) TDD_CHANGE=\{\{\.inputs\.change\}\} bash \{\{\.awf\.scripts_dir\}\}\/tdd-gate\.sh green /);
  assert.match(check, /continue_on_error: true/);
  assert.match(check, /ExitCode == 0'\n\s+goto: review/);
  assert.match(check, /ExitCode == 50'\n\s+goto: database_unavailable/);
  assert.match(check, /- goto: green_turn\n/);
  assert.doesNotMatch(check, /goto: green_failed/);
  assert.match(text, /database_unavailable:\n\s+type: step\n\s+command: "false"\n\s+on_failure: \{message: .*status: 50\}/);
  assert.match(text, /green_failed:\n\s+type: step\n\s+command: "false"\n\s+on_failure: \{message: "GREEN: three turns without progress\. \{\{\.states\.check_green\.Output\}\}", status: 20\}/);
});

test('php, ts and go check the critical trace after RED, then reset the turn counter and cap the GREEN fixes', () => {
  for (const l of ['php', 'ts', 'go']) {
    const block = (state: string) => blockOf(`tdd-slice-${l}.yaml`, state);
    assert.match(block('check_red'), /on_success: check_trace/, l);
    assert.match(block('check_trace'), /\[ '\{\{\.inputs\.critical\}\}' = true \] \|\| exit 0\n\s+bash \{\{\.awf\.scripts_dir\}\}\/critical-trace\.sh /, l);
    assert.match(block('check_trace'), /on_success: init_turns/, l);
    assert.match(block('init_turns'), /tdd-gate\.sh green-turn reset\n\s+on_success: green\n/, l);
    assert.match(block('green_turn'), /tdd-gate\.sh green-turn count\n\s+on_success: back_to_green\n\s+on_failure: green_failed/, l);
    assert.match(block('back_to_green'), /on_success: check_green/, l);
  }
});

test('the four tdd-slice-* have the same states, php adding the code 50 states, php and ts the resume states, threejs art_direction and no trace', () => {
  const names = (l: string) => states(`tdd-slice-${l}.yaml`).filter((s) => !['database_unavailable', 'route_review', 'review_database_unavailable', 'art_direction', 'check_trace', ...RESUME].includes(s));
  for (const l of ['ts', 'go', 'threejs']) assert.deepEqual(names(l).sort(), names('php').sort(), l);
});

test('tdd-slice-ts, go and threejs cap the GREEN fixes without a code 50 branch', () => {
  for (const l of ['ts', 'go', 'threejs']) {
    const block = (state: string) => blockOf(`tdd-slice-${l}.yaml`, state);
    assert.match(block(l === 'threejs' ? 'check_red' : 'check_trace'), /on_success: init_turns/, l);
    assert.match(block('init_turns'), /tdd-gate\.sh green-turn reset\n\s+on_success: green\n/, l);
    const check = block('check_green');
    assert.match(check, /continue_on_error: true/, l);
    assert.match(check, /ExitCode == 0'\n\s+goto: review/, l);
    assert.match(check, /- goto: green_turn\n/, l);
    assert.doesNotMatch(check, /ExitCode == 50|database_unavailable/, l);
    assert.match(block('green_turn'), /tdd-gate\.sh green-turn count\n\s+on_success: back_to_green\n\s+on_failure: green_failed/, l);
    assert.match(block('green_failed'), /command: "false"\n\s+on_failure: \{message: "GREEN: three turns without progress\. .*status: 20\}/, l);
    assert.match(block('back_to_green'), /on_success: check_green/, l);
  }
});

test('the back-to-GREEN prompts name the review and the GREEN phase suite as the origin of the failure', () => {
  const prompts = join(WORKFLOWS, '..', 'prompts');
  for (const f of ['tdd-back-to-green.md', 'tdd-threejs-back-to-green.md']) {
    const text = readFileSync(join(prompts, f), 'utf8');
    assert.match(text, /after a failure of the review or of the GREEN phase suite/, f);
    assert.match(text, /The review or the GREEN phase suite failed/, f);
  }
});

test('tdd-slice-php passes change and slice to the review and stops code 50 without classify', () => {
  const block = (state: string) => blockOf('tdd-slice-php.yaml', state);
  assert.match(block('review'), /workflow: review\n\s+inputs:\n\s+language: "\{\{\.inputs\.hexagon\}\}"\n\s+change: "\{\{\.inputs\.change\}\}"\n\s+slice: "\{\{\.inputs\.slice\}\}"\n\s+base: "\{\{\.inputs\.base\}\}"\n/);
  assert.match(block('review'), /on_failure: route_review/);
  assert.match(block('route_review'), /command: jq -e '\.code == 50' \.awf\/status\/tdd-slice\.json\n\s+on_success: review_database_unavailable\n\s+on_failure: classify/);
  assert.match(block('review_database_unavailable'), /command: "false"\n\s+on_failure: \{message: .*status: 50\}/);
  assert.doesNotMatch(block('review_database_unavailable'), /classify/);
});

test('the final review of apply-change calls review for each touched language, without slice or base', () => {
  const block = blockOf('apply-change.yaml', 'final_review');
  assert.match(block, /workflow: review\n\s+inputs:\n\s+change: "\{\{\.inputs\.change\}\}"\n\s+language: "\{\{\.loop\.Item\}\}"\n/);
  assert.doesNotMatch(block, /slice|base|resume/);
});

test('tdd-slice-php and tdd-slice-ts receive base, empty by default, and pass it to their review', () => {
  for (const language of ['php', 'ts']) {
    const text = readFileSync(join(WORKFLOWS, `tdd-slice-${language}.yaml`), 'utf8');
    assert.match(text.split(/^states:/m)[0]!, /  - name: base\n    type: string\n    default: ""\n/, language);
    assert.match(blockOf(`tdd-slice-${language}.yaml`, 'review'), /workflow: review\n\s+inputs:\n\s+language: "\{\{\.inputs\.hexagon\}\}"\n\s+change: "\{\{\.inputs\.change\}\}"\n\s+slice: "\{\{\.inputs\.slice\}\}"\n\s+base: "\{\{\.inputs\.base\}\}"\n/, language);
  }
});

test('tdd-slice-threejs and tdd-slice-go receive no base', () => {
  for (const language of ['threejs', 'go']) {
    assert.doesNotMatch(readFileSync(join(WORKFLOWS, `tdd-slice-${language}.yaml`), 'utf8'), /name: base\b|inputs\.base/, language);
  }
});

test('tdd-slice-php and tdd-slice-ts resume the review after going back to RED, through resume then review_resume', () => {
  for (const [language, failure] of [['php', 'route_review'], ['ts', 'classify']] as const) {
    const block = (state: string) => blockOf(`tdd-slice-${language}.yaml`, state);
    assert.match(block('check_back_to_red'), /on_success: resume\n/, language);
    assert.match(block('resume'), /type: step\n\s+command: bash \{\{\.awf\.scripts_dir\}\}\/tdd-gate\.sh resume-tool \{\{\.inputs\.hexagon\}\}\n\s+on_success: review_resume\n/, language);
    assert.match(block('review_resume'), new RegExp(`workflow: review\\n\\s+inputs:\\n\\s+language: "\\{\\{\\.inputs\\.hexagon\\}\\}"\\n\\s+change: "\\{\\{\\.inputs\\.change\\}\\}"\\n\\s+slice: "\\{\\{\\.inputs\\.slice\\}\\}"\\n\\s+base: "\\{\\{\\.inputs\\.base\\}\\}"\\n\\s+resume: "\\{\\{\\.states\\.resume\\.Output\\}\\}"\\n`), language);
    // Same outcome as `review`: success ends the slice, failure goes through the same routing.
    assert.match(block('review'), new RegExp(`on_success: done\\n\\s+on_failure: ${failure}\\n`), language);
    assert.match(block('review_resume'), new RegExp(`on_success: done\\n\\s+on_failure: ${failure}\\n`), language);
    assert.doesNotMatch(block('review'), /resume/, language);
    // Going back to GREEN keeps its path: check_green, then the review from its first tool.
    assert.match(block('back_to_green'), /on_success: check_green\n/, language);
    assert.match(block('check_green'), /ExitCode == 0'\n\s+goto: review\n/, language);
  }
});

test('neither apply-change, nor tdd-slice-go, nor tdd-slice-threejs pass resume', () => {
  for (const file of ['apply-change.yaml', 'tdd-slice-go.yaml', 'tdd-slice-threejs.yaml']) {
    assert.doesNotMatch(readFileSync(join(WORKFLOWS, file), 'utf8'), /\bresume\b|review_resume/, file);
  }
});

// --- Rust slices and critical slices ---

test('tdd-slice-rust: RED, trace of critical scenarios, GREEN capped at three turns, review, mutants back to RED', () => {
  assert.deepEqual(states('tdd-slice-rust.yaml'), [
    'red', 'check_red', 'check_trace', 'init_turns', 'green', 'check_green', 'green_turn', 'green_failed', 'review', 'classify',
    'mutants', 'check_mutants', 'fix', 'agent_failed', 'stop', 'done',
  ]);
  assert.match(blockOf('tdd-slice-rust.yaml', 'check_red'), /tdd-gate\.sh red \{\{\.inputs\.hexagon\}\}[^\n]*\n\s+on_success: check_trace\n/);
  assert.match(blockOf('tdd-slice-rust.yaml', 'green_turn'), /tdd-gate\.sh green-turn count\n\s+on_success: fix\n\s+on_failure: green_failed/);
  assert.match(blockOf('tdd-slice-rust.yaml', 'check_mutants'), /tdd-gate\.sh red-mutants /);
});

test('tdd-slice-rust: the trace runs only for a critical slice, before GREEN', () => {
  const trace = blockOf('tdd-slice-rust.yaml', 'check_trace');
  assert.match(trace, /\[ '\{\{\.inputs\.critical\}\}' = true \] \|\| exit 0\n\s+bash \{\{\.awf\.scripts_dir\}\}\/critical-trace\.sh \{\{\.inputs\.change\}\} \{\{\.inputs\.hexagon\}\}\n/);
  assert.match(trace, /on_success: init_turns\n/);
});

test('tdd-slice-rust-perf: baseline before any change, then optimize, measure and review, three turns at most', () => {
  assert.deepEqual(states('tdd-slice-rust-perf.yaml'), ['baseline', 'init_turns', 'optimize', 'check_perf', 'perf_error', 'review', 'turn', 'turns_exhausted', 'agent_failed', 'stop', 'done']);
  assert.match(blockOf('tdd-slice-rust-perf.yaml', 'baseline'), /perf-gate\.sh baseline \{\{\.inputs\.hexagon\}\}/);
  const check = blockOf('tdd-slice-rust-perf.yaml', 'check_perf');
  assert.match(check, /perf-gate\.sh check \{\{\.inputs\.hexagon\}\}/);
  assert.match(check, /ExitCode == 0'\n\s+goto: review\n\s+- when: 'states\.check_perf\.ExitCode == 20'\n\s+goto: turn\n\s+- goto: perf_error\n/);
  assert.match(blockOf('tdd-slice-rust-perf.yaml', 'review'), /on_success: done\n\s+on_failure: turn\n/);
});

test('apply-task passes [critical] to the Rust slices, which pass it to the review with the change', () => {
  assert.match(blockOf('apply-task.yaml', 'slice_critical'), /jq -j '\.critical \/\/ false'/);
  for (const state of ['run_rust', 'run_rust_perf']) assert.match(blockOf('apply-task.yaml', state), /critical: "\{\{\.states\.slice_critical\.Output\}\}"\n/, state);
  for (const file of ['tdd-slice-rust.yaml', 'tdd-slice-rust-perf.yaml']) {
    const review = blockOf(file, 'review');
    assert.match(review, /critical: "\{\{\.inputs\.critical\}\}"\n/, file);
    assert.match(review, /change: "\{\{\.inputs\.change\}\}"\n/, file);
    assert.match(readFileSync(join(WORKFLOWS, file), 'utf8').split(/^states:/m)[0]!, /  - name: critical\n    type: string\n    default: "false"\n/, file);
  }
});
