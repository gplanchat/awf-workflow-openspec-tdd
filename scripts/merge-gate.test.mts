import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'merge-gate.sh');
const work = mkdtempSync(join(tmpdir(), 'merge-gate-'));
after(() => rmSync(work, { recursive: true, force: true }));

const STEPS = ['PHPSTAN', 'PSALM', 'UNIT', 'FUNCTIONAL', 'TSC', 'ESLINT', 'VITEST'];

// Language registry of the throwaway repository. The commands are `false`: each test replaces them with
// MERGE_GATE_CMD_<NAME>. threejs shares the directory of ts and the alias api is php: no check may run twice.
const REGISTRY = `php:
  dir: api
  merge_checks:
    phpstan: 'false'
    psalm: 'false'
    unit: 'false'
    functional: 'false'
ts:
  dir: pwa
  merge_checks:
    tsc: 'false'
    eslint: 'false'
    vitest: 'false'
threejs:
  dir: pwa
  merge_checks:
    tsc: 'false'
    eslint: 'false'
    vitest: 'false'
api:
  alias: php
docs:
  workflow: free-task
`;

function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} : ${r.stderr}`);
  return r.stdout.trim();
}

// Throwaway repository on main with a shared file; `files` is added on the `feature` branch.
function repo(files: Record<string, string>, onMain: Record<string, string> = {}) {
  const dir = mkdtempSync(join(work, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, '.git/info/exclude'), '.awf/status/\n'); // like the repository's .gitignore
  const put = (map: Record<string, string>) => {
    for (const [path, content] of Object.entries(map)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, 'add', '-A');
  };
  put({ 'README.md': 'base\n', '.awf/languages.yaml': REGISTRY });
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put(files);
  git(dir, 'commit', '-q', '-m', 'feature');
  git(dir, 'checkout', '-q', 'main');
  if (Object.keys(onMain).length > 0) {
    put(onMain);
    git(dir, 'commit', '-q', '-m', 'main');
  }
  return dir;
}

// Each step is a fake that writes its name to `calls`; `failing` makes one of them fail.
function run(dir: string, args: string[], failing?: string, env: Record<string, string> = {}) {
  const calls = join(dir, '..', `calls-${Math.random().toString(36).slice(2)}`);
  const stepEnv = Object.fromEntries(
    STEPS.map((s) => [`MERGE_GATE_CMD_${s}`, `echo ${s} >> ${calls}${s === failing ? '; echo boom; exit 1' : ''}`]),
  );
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...stepEnv, ...env } });
  const called = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
  return { status: r.status, output: `${r.stdout}${r.stderr}`, called };
}

test('documentation branch: no step, merge committed with the message', () => {
  const dir = repo({ 'openspec/a.md': 'doc\n' });
  const r = run(dir, ['merge', 'feature', 'merge(docs): given message']);

  assert.equal(r.status, 0);
  assert.deepEqual(r.called, []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'merge(docs): given message');
  assert.equal(git(dir, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3);
});

test('api/ only: PHPStan, Psalm, unit then functional', () => {
  const r = run(repo({ 'api/a.php': '<?php\n' }), ['merge', 'feature', 'm']);

  assert.equal(r.status, 0);
  assert.deepEqual(r.called, ['PHPSTAN', 'PSALM', 'UNIT', 'FUNCTIONAL']);
});

test('pwa/ only: tsc, ESLint then vitest', () => {
  const r = run(repo({ 'pwa/a.ts': '1\n' }), ['merge', 'feature', 'm']);

  assert.equal(r.status, 0);
  assert.deepEqual(r.called, ['TSC', 'ESLINT', 'VITEST']);
});

test('api/ and pwa/: api/ first', () => {
  const r = run(repo({ 'pwa/a.ts': '1\n', 'api/a.php': '<?php\n' }), ['merge', 'feature', 'm']);

  assert.equal(r.status, 0);
  assert.deepEqual(r.called, ['PHPSTAN', 'PSALM', 'UNIT', 'FUNCTIONAL', 'TSC', 'ESLINT', 'VITEST']);
});

test('first step fails: code 30, step named, same HEAD, clean tree, later steps not run', () => {
  const dir = repo({ 'api/a.php': '<?php\n', 'pwa/a.ts': '1\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  const r = run(dir, ['merge', 'feature', 'm'], 'PHPSTAN');

  assert.equal(r.status, 30);
  assert.match(r.output, /PHPSTAN/);
  assert.match(r.output, /boom/);
  assert.deepEqual(r.called, ['PHPSTAN']);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(dir, 'api/a.php')), false);
});

test('a failing middle step stops the gate', () => {
  const r = run(repo({ 'api/a.php': '<?php\n' }), ['merge', 'feature', 'm'], 'UNIT');

  assert.equal(r.status, 30);
  assert.deepEqual(r.called, ['PHPSTAN', 'PSALM', 'UNIT']);
});

test('conflict: code 2, files listed, no step, merge aborted', () => {
  const dir = repo({ 'README.md': 'feature\n', 'api/a.php': '<?php\n' }, { 'README.md': 'main\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  const r = run(dir, ['merge', 'feature', 'm']);

  assert.equal(r.status, 2);
  assert.match(r.output, /README\.md/);
  assert.deepEqual(r.called, []);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('invalid input: code 2', () => {
  const dir = repo({ 'openspec/a.md': 'doc\n' });

  assert.equal(run(dir, ['merge', 'feature']).status, 2);
  assert.equal(run(dir, ['merge', 'missing', 'm']).status, 2);
  assert.equal(run(dir, []).status, 2);
});

test('check: exits 0 without running anything outside main or with MERGE_GATE_DONE=1', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'feature');

  assert.deepEqual(run(dir, ['check'], undefined, { MERGE_GATE_DONE: '1' }).called, []);
  assert.deepEqual(run(dir, ['check']).called, ['PHPSTAN', 'PSALM', 'UNIT', 'FUNCTIONAL']);
  git(dir, 'merge', '--abort');
  git(dir, 'checkout', '-q', 'feature');
  assert.deepEqual(run(dir, ['check']).called, []);
});

test('report: steps run, seconds and total, no temporary file', () => {
  const dir = repo({ 'pwa/a.ts': '1\n' });
  const r = run(dir, ['merge', 'feature', 'm'], undefined, { MERGE_GATE_CMD_VITEST: 'sleep 0.2' });
  const report = JSON.parse(readFileSync(join(dir, '.awf/status/merge-gate.json'), 'utf8'));

  assert.equal(r.status, 0);
  assert.deepEqual(report.steps.map((s: { step: string }) => s.step), ['TSC', 'ESLINT', 'VITEST']);
  assert.ok(report.steps[2].seconds >= 0.2);
  assert.ok(report.total >= report.steps[2].seconds);
  assert.equal(existsSync(join(dir, '.awf/status/merge-gate.json.tmp')), false);
  assert.doesNotMatch(r.output, /warning/);
});

test('report: a failed step is in the report', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  run(dir, ['merge', 'feature', 'm'], 'PSALM');

  const report = JSON.parse(readFileSync(join(dir, '.awf/status/merge-gate.json'), 'utf8'));
  assert.deepEqual(report.steps.map((s: { step: string }) => s.step), ['PHPSTAN', 'PSALM']);
});

test('budget lowered to 0: warning, the merge is still committed', () => {
  const dir = repo({ 'pwa/a.ts': '1\n' });
  const r = run(dir, ['merge', 'feature', 'm'], undefined, { MERGE_GATE_BUDGET: '0' });

  assert.equal(r.status, 0);
  assert.match(r.output, /warning.*budget of 0 s/);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'm');
});

const HOOKS = join(dirname(SCRIPT), '..', 'hooks');

// Merge by hand with the pack's hook turned on (absolute path: the throwaway repository has no hooks of its own).
function manualMerge(dir: string, branch: string, hook: boolean) {
  if (hook) git(dir, 'config', 'core.hooksPath', HOOKS);
  const calls = join(dir, '..', `calls-${Math.random().toString(36).slice(2)}`);
  const stepEnv = Object.fromEntries(STEPS.map((s) => [`MERGE_GATE_CMD_${s}`, `echo ${s} >> ${calls}; exit 1`]));
  const r = spawnSync('git', ['merge', '--no-ff', '-m', 'by hand', branch], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...stepEnv } });
  return { status: r.status, called: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [] };
}

test('hook on: a git merge --no-ff by hand on main fails without writing the commit', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  const r = manualMerge(dir, 'feature', true);

  assert.notEqual(r.status, 0);
  assert.deepEqual(r.called, ['PHPSTAN']);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
});

test('hook off: the same git merge passes', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  const r = manualMerge(dir, 'feature', false);

  assert.equal(r.status, 0);
  assert.deepEqual(r.called, []);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'by hand');
});

test('hook on outside main: no check', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  git(dir, 'checkout', '-q', '-b', 'other', 'main');
  const r = manualMerge(dir, 'feature', true);

  assert.equal(r.status, 0);
  assert.deepEqual(r.called, []);
});

test('install: sets core.hooksPath', () => {
  const dir = repo({ 'openspec/a.md': 'doc\n' });
  const r = run(dir, ['install']);

  assert.equal(r.status, 0);
  assert.equal(git(dir, 'config', 'core.hooksPath'), resolve(HOOKS), 'the hooks of the pack, not of the project');
});

test('install with an existing hook: code 2, setting unchanged', () => {
  const dir = repo({ 'openspec/a.md': 'doc\n' });
  writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\n');
  const r = run(dir, ['install']);

  assert.equal(r.status, 2);
  assert.match(r.output, /pre-commit/);
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir }).status, 1);
});

test('unreadable registry: code 2, the merge is aborted', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  rmSync(join(dir, '.awf/languages.yaml'));
  git(dir, 'commit', '-q', '-am', 'no registry');
  const before = git(dir, 'rev-parse', 'HEAD');
  const r = run(dir, ['merge', 'feature', 'm']);

  assert.equal(r.status, 2);
  assert.match(r.output, /registry \.awf\/languages\.yaml of branch main is missing or cannot be read/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
});

test('BASE_BRANCH: the gate merges into this branch and checks nothing elsewhere', () => {
  const dir = repo({ 'api/a.php': '<?php\n' });
  git(dir, 'branch', '-m', 'main', 'trunk');
  const r = run(dir, ['merge', 'feature', 'm'], undefined, { BASE_BRANCH: 'trunk' });

  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.called, ['PHPSTAN', 'PSALM', 'UNIT', 'FUNCTIONAL']);
  assert.equal(run(repo({ 'api/a.php': '<?php\n' }), ['merge', 'feature', 'm'], undefined, { BASE_BRANCH: 'trunk' }).status, 2);
});

test('a check name outside [a-z0-9] gives MERGE_GATE_CMD_ with underscores', () => {
  const dir = repo({ 'go/a.go': 'package a\n' }, { '.awf/languages.yaml': `${REGISTRY}go:\n  dir: go\n  merge_checks:\n    go-vet: 'false'\n` });
  const calls = join(dir, '..', 'calls-go');
  const r = spawnSync('bash', [SCRIPT, 'merge', 'feature', 'm'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MERGE_GATE_CMD_GO_VET: `echo GO_VET >> ${calls}` } });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(calls, 'utf8'), 'GO_VET\n');
});

test('dir: . is the repository root: any file of the merge runs its checks', () => {
  const dir = repo({ 'src/a.rs': 'fn a() {}\n' }, { '.awf/languages.yaml': `${REGISTRY}rust:\n  dir: .\n  merge_checks:\n    clippy: 'false'\n` });
  const calls = join(dir, '..', 'calls-root');
  const r = spawnSync('bash', [SCRIPT, 'merge', 'feature', 'm'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MERGE_GATE_CMD_CLIPPY: `echo CLIPPY >> ${calls}` } });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(calls, 'utf8'), 'CLIPPY\n');
});

test('the registry read is the one of main: a branch that removes its checks is still checked', () => {
  const dir = repo({ 'api/a.php': '<?php\n', '.awf/languages.yaml': 'docs:\n  workflow: free-task\n' });
  const r = run(dir, ['merge', 'feature', 'm']);

  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.called, ['PHPSTAN', 'PSALM', 'UNIT', 'FUNCTIONAL']);
});
