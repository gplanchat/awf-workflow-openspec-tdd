// perf-gate.sh: baseline at the start of a performance slice, then target and tolerance check. The `perf` command of
// the test registry reads the measurement of each benchmark from a file the test writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'perf-gate.sh');
const work = mkdtempSync(join(tmpdir(), 'perf-gate-'));
after(() => rmSync(work, { recursive: true, force: true }));

const REGISTRY = `rust:
  workflow: tdd-slice-rust
  perf_tolerance: 2
rust-perf:
  alias: rust
  workflow: tdd-slice-rust-perf
  perf: cat measures/{bench}
  perf_benches: [fib, strings]
no-perf:
  workflow: tdd-slice-rust
`;

function repo(): string {
  const root = mkdtempSync(join(work, 'p-'));
  mkdirSync(join(root, '.awf'), { recursive: true });
  mkdirSync(join(root, 'measures'));
  writeFileSync(join(root, '.awf', 'languages.yaml'), REGISTRY);
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

const measure = (root: string, values: Record<string, string>) => {
  for (const [bench, value] of Object.entries(values)) writeFileSync(join(root, 'measures', bench), `noise\n${value}\n`);
};

function gate(root: string, phase: string, slice: string, language = 'rust-perf') {
  const result = spawnSync('bash', [SCRIPT, phase, language, slice], { cwd: root, encoding: 'utf8', env: { ...process.env, OPENSPEC_ROOT: root, LC_ALL: 'fr_FR.UTF-8' } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const SLICE = '3.1.1 speed up the recursion target: -10% instructions fib';

test('baseline measures the target and every watched benchmark, alias and tolerance included', () => {
  const root = repo();
  measure(root, { fib: '1000', strings: '500' });

  assert.equal(gate(root, 'baseline', SLICE).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.awf', 'status', 'perf-base.json'), 'utf8')), { target: 'fib', gain: 10, base: { fib: 1000, strings: 500 } });
});

test('check passes when the target drops enough and the others stay within the tolerance, whatever the locale', () => {
  const root = repo();
  measure(root, { fib: '1000', strings: '500' });
  gate(root, 'baseline', SLICE);
  measure(root, { fib: '880', strings: '505' });
  const { status, output } = gate(root, 'check', SLICE);

  assert.equal(status, 0, output);
  assert.match(output, /fib: 1000 -> 880 \(-12\.00%\), target -10%: ok/);
  assert.match(readFileSync(join(root, '.awf', 'status', 'review-last.txt'), 'utf8'), /strings: 500 -> 505 \(1\.00%\), tolerance \+2%: ok/);
});

test('check fails with 20 on a missed target', () => {
  const root = repo();
  measure(root, { fib: '1000', strings: '500' });
  gate(root, 'baseline', SLICE);
  measure(root, { fib: '950' });
  const { status, output } = gate(root, 'check', SLICE);

  assert.equal(status, 20);
  assert.match(output, /fib: 1000 -> 950 \(-5\.00%\), target -10%: FAILED/);
});

test('check fails with 20 when a gain on the target hides a regression above the tolerance elsewhere', () => {
  const root = repo();
  measure(root, { fib: '1000', strings: '500' });
  gate(root, 'baseline', SLICE);
  measure(root, { fib: '800', strings: '520' });
  const { status, output } = gate(root, 'check', SLICE);

  assert.equal(status, 20);
  assert.match(output, /strings: 500 -> 520 \(4\.00%\), tolerance \+2%: FAILED/);
});

test('a measurement whose last line is not a number exits 12', () => {
  const root = repo();
  measure(root, { fib: 'n/a', strings: '500' });

  assert.equal(gate(root, 'baseline', SLICE).status, 12);
});

test('a slice without target, a language without perf command, or check without baseline exit 2', () => {
  const root = repo();
  measure(root, { fib: '1000', strings: '500' });

  assert.match(gate(root, 'baseline', '3.1.1 speed up the recursion').output, /target: -10% <bench>/);
  assert.equal(gate(root, 'baseline', '3.1.1 speed up the recursion').status, 2);
  assert.equal(gate(root, 'baseline', SLICE, 'no-perf').status, 2);
  assert.equal(gate(root, 'check', SLICE).status, 2);
  assert.equal(spawnSync('bash', [SCRIPT, 'measure', 'rust-perf', SLICE], { cwd: root }).status, 2);
});
