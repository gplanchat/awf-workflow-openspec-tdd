// cargo-test-junit.sh: JUnit report from the text output of `cargo test` on stable Rust (no cargo needed here, the
// output is a fixture).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cargo-test-junit.sh');
const work = mkdtempSync(join(tmpdir(), 'cargo-test-junit-'));
after(() => rmSync(work, { recursive: true, force: true }));

function convert(output: string): { status: number | null; stderr: string; report: string | null } {
  const report = join(work, `r-${Math.random().toString(36).slice(2)}`, 'junit.xml');
  const result = spawnSync('bash', [SCRIPT, report], { encoding: 'utf8', input: output });
  return { status: result.status, stderr: result.stderr, report: existsSync(report) ? readFileSync(report, 'utf8') : null };
}

const OUTPUT = `   Compiling demo v0.1.0 (/tmp/demo)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 0.40s
     Running unittests src/lib.rs (target/debug/deps/demo-0123)

running 3 tests
test add::tests::later ... ignored
test add::tests::adds_two_numbers ... FAILED
test add::tests::adds_zero ... ok

failures:

---- add::tests::adds_two_numbers stdout ----

thread 'add::tests::adds_two_numbers' panicked at src/add/tests.rs:5:5:
assertion \`left == right\` failed
  left: -1
 right: <5> & "x"

failures:
    add::tests::adds_two_numbers

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

test('a failing test, a passing one and an ignored one give tests, failures and skipped counts', () => {
  const { status, report } = convert(OUTPUT);

  assert.equal(status, 0);
  assert.match(report ?? '', /<testsuites tests="3" failures="1" errors="0" skipped="1">/);
  assert.match(report ?? '', /<testcase name="add::tests::adds_zero" classname="cargo"\/>/);
  assert.match(report ?? '', /<testcase name="add::tests::later" classname="cargo"><skipped\/><\/testcase>/);
});

test('the failure message is the stdout block of the test, XML-escaped', () => {
  const report = convert(OUTPUT).report ?? '';
  const failure = report.match(/<testcase name="add::tests::adds_two_numbers"[^>]*><failure message="test failed">([^]*?)<\/failure>/)?.[1] ?? '';

  assert.match(failure, /panicked at src\/add\/tests\.rs:5:5/);
  assert.match(failure, /right: &lt;5&gt; &amp; &quot;x&quot;/);
  assert.doesNotMatch(failure, /failures:/);
});

test('a compilation error prints no test line: no report, exit 1', () => {
  const { status, stderr, report } = convert('error[E0425]: cannot find function `sub` in module `super`\nerror: could not compile `demo`\n');

  assert.equal(status, 1);
  assert.equal(report, null);
  assert.match(stderr, /no test result/);
});

test('without a report path the script exits 1 with its usage', () => {
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', input: OUTPUT });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: cargo-test-junit\.sh <report>/);
});
