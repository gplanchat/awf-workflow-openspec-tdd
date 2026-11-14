// critical-trace.sh: each scenario marked `critical:` in the specs of a change is linked to a test by
// `// scenario: <exact title>`, under the `tests` patterns or the `harness_paths` of the language.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'critical-trace.sh');
const work = mkdtempSync(join(tmpdir(), 'critical-trace-'));
after(() => rmSync(work, { recursive: true, force: true }));

const REGISTRY = `rust:
  workflow: tdd-slice-rust
  tests:
    - '(^|/)(tests|[a-z0-9_]+_tests)\\.rs$'
  harness_paths: [fuzz]
`;

const SPEC = `### Requirement: Store

#### Scenario: A write survives a crash

critical: data-loss, revenue
- WHEN the process stops during a write
- THEN the record is complete or absent

#### Scenario: Plain listing
- WHEN the list is read

#### Scenario: Fuzzed parser never panics
critical: safety
`;

function repo(files: Record<string, string>, spec = SPEC): string {
  const root = mkdtempSync(join(work, 'p-'));
  const all = { '.awf/languages.yaml': REGISTRY, 'openspec/changes/c1/specs/store/spec.md': spec, ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function trace(root: string, change = 'c1') {
  const result = spawnSync('bash', [SCRIPT, change, 'rust'], { cwd: root, encoding: 'utf8', env: { ...process.env, OPENSPEC_ROOT: root } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const LINKED = {
  'src/store/tests.rs': '// scenario: A write survives a crash\n#[test]\nfn survives() {}\n',
  'fuzz/fuzz_targets/parse.rs': '// scenario: Fuzzed parser never panics\n',
};

test('every critical scenario linked, in untracked test files and under harness_paths: 0', () => {
  const { status, output } = trace(repo(LINKED));

  assert.equal(status, 0, output);
  assert.match(output, /2 critical scenario\(s\), each linked to a test/);
});

test('a critical scenario without a linked test is named, exit 30; a non-critical one needs no link', () => {
  const { status, output } = trace(repo({ 'src/store/tests.rs': LINKED['src/store/tests.rs'] }));

  assert.equal(status, 30);
  assert.match(output, /Critical scenario without a linked test: Fuzzed parser never panics/);
  assert.doesNotMatch(output, /Plain listing/);
});

test('a link outside the tests patterns and harness_paths does not count', () => {
  const { status } = trace(repo({ ...LINKED, 'src/store/tests.rs': '', 'src/store/mod.rs': '// scenario: A write survives a crash\n' }));

  assert.equal(status, 30);
});

test('a renamed scenario breaks its link', () => {
  const { status, output } = trace(repo(LINKED, SPEC.replace('A write survives a crash', 'A write survives a power cut')));

  assert.equal(status, 30);
  assert.match(output, /without a linked test: A write survives a power cut/);
});

test('an unknown category fails with the allowed list', () => {
  const { status, output } = trace(repo(LINKED, SPEC.replace('data-loss, revenue', 'data-loss, money')));

  assert.equal(status, 30);
  assert.match(output, /unknown category « money »: A write survives a crash \(allowed: data-loss, data-leak, revenue, reputation, safety\)/);
});

test('a change without specs or without critical scenario passes; missing arguments exit 2', () => {
  const root = repo(LINKED, SPEC.replaceAll(/^critical: .*\n/gm, ''));

  assert.equal(trace(root).status, 0);
  assert.equal(trace(root, 'unknown').status, 0);
  assert.equal(spawnSync('bash', [SCRIPT, 'c1'], { cwd: root }).status, 2);
});
