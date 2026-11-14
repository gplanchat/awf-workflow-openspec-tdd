// go-test-junit.sh: JUnit report from the output of `go test -json`. The outputs are fixtures recorded with Go 1.27
// (no Go toolchain needed here).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'go-test-junit.sh');
const work = mkdtempSync(join(tmpdir(), 'go-test-junit-'));
after(() => rmSync(work, { recursive: true, force: true }));

function convert(output: string): { status: number | null; stderr: string; report: string | null } {
  const report = join(work, `r-${Math.random().toString(36).slice(2)}`, 'junit.xml');
  const result = spawnSync('bash', [SCRIPT, report], { encoding: 'utf8', input: output });
  return { status: result.status, stderr: result.stderr, report: existsSync(report) ? readFileSync(report, 'utf8') : null };
}

// Package calc: TestAddZero passes, TestAdd fails through its subtest TestAdd/two, TestLater is skipped.
const FAILING = readFileSync(join(HERE, 'fixtures', 'go-test-json-failing.jsonl'), 'utf8');
// The same package, plus the package broken whose test calls a function that does not exist.
const BUILD_FAILED = readFileSync(join(HERE, 'fixtures', 'go-test-json-build-failed.jsonl'), 'utf8');

test('passing, failing and skipped tests, subtests included, give tests, failures and skipped counts', () => {
  const { status, report } = convert(FAILING);

  assert.equal(status, 0);
  assert.match(report ?? '', /<testsuites tests="4" failures="2" errors="0" skipped="1">/);
  assert.match(report ?? '', /<testcase name="TestAddZero" classname="example\.com\/demo\/calc"\/>/);
  assert.match(report ?? '', /<testcase name="TestLater" classname="example\.com\/demo\/calc"><skipped\/><\/testcase>/);
});

test('the failure message is the output of the failing test, XML-escaped', () => {
  const report = convert(FAILING).report ?? '';
  const failure = report.match(/<testcase name="TestAdd\/two"[^>]*><failure message="test failed">([^]*?)<\/failure>/)?.[1] ?? '';

  assert.match(failure, /calc_test\.go:14: Add\(2, 3\) = -1/);
  assert.match(failure, /want &lt;5&gt; &amp; &quot;x&quot;/);
  assert.doesNotMatch(failure, /TestAddZero/);
});

test('a package that does not build fails without a failing test: no report, exit 1, the package named', () => {
  const { status, stderr, report } = convert(BUILD_FAILED);

  assert.equal(status, 1);
  assert.equal(report, null);
  assert.match(stderr, /example\.com\/demo\/broken failed without a failing test/);
});

test('an output without any test result writes no report and exits 1', () => {
  const { status, stderr, report } = convert('go: cannot find main module\n');

  assert.equal(status, 1);
  assert.equal(report, null);
  assert.match(stderr, /no test result/);
});

test('without a report path the script exits 1 with its usage', () => {
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', input: FAILING });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: go-test-junit\.sh <report>/);
});
