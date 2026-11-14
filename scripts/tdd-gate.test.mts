import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'tdd-gate.sh');
// Registry of the test project: the gate reads .awf/languages.yaml under OPENSPEC_ROOT (default: the git root of the cwd).
const FIXTURE = join(dirname(SCRIPT), 'fixtures', 'project');
process.env.OPENSPEC_ROOT = FIXTURE;
const work = mkdtempSync(join(tmpdir(), 'tdd-gate-'));
// The launcher may limit the load (TDD_NICE, TDD_CPU_PERCENT): these settings must not enter the expected commands.
for (const name of ['TDD_NICE', 'TDD_CPU_PERCENT', 'TDD_MEMORY_MAX', 'DATABASE_URL']) delete process.env[name];
after(() => rmSync(work, { recursive: true, force: true }));

const report = (tests: number, failures: number, errors = 0) =>
  `printf '<testsuites tests="${tests}" failures="${failures}" errors="${errors}"></testsuites>' > "$TDD_REPORT"`;

function gate(phase: string, hexagon: string, env: Record<string, string> = {}, args: string[] = []) {
  const statusFile = join(work, `status-${Math.random().toString(36).slice(2)}.json`);
  const result = spawnSync('bash', [SCRIPT, phase, hexagon, ...args], {
    encoding: 'utf8',
    cwd: work,
    env: { ...process.env, XDG_RUNTIME_DIR: work, TDD_STATUS_FILE: statusFile, TDD_REPORT: join(work, 'gate.xml'), ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, statusFile };
}

test('RED: a failing test in the report opens the GREEN phase', () => {
  const { status, output } = gate('red', 'api', { TDD_RED_CMD: report(3, 1) });

  assert.equal(status, 0);
  assert.match(output, /1 test failure\(s\) out of 3/);
});

test('RED: a test error counts as a failure', () => {
  assert.equal(gate('red', 'pwa', { TDD_RED_CMD: report(2, 0, 1) }).status, 0);
});

test('RED: a test that passes without production code proves nothing (code 10)', () => {
  const { status, output } = gate('red', 'api', { TDD_RED_CMD: report(3, 0) });

  assert.equal(status, 10);
  assert.match(output, /proves nothing/);
});

test('RED: a startup failure without a test report fails the phase (code 12)', () => {
  const { status, output } = gate('red', 'pwa', { TDD_RED_CMD: 'echo "Error: No projects matched the filter"; exit 1' });

  assert.equal(status, 12);
  assert.match(output, /no test report/);
  assert.match(output, /No projects matched/);
});

test('RED: the report folder is created when missing', () => {
  const { status } = gate('red', 'api', { TDD_RED_CMD: report(2, 1), TDD_REPORT: join(work, 'new', 'sub', 'gate.xml') });

  assert.equal(status, 0);
});

test('RED: a stale report from a previous run is not read again', () => {
  gate('red', 'api', { TDD_RED_CMD: report(3, 1), TDD_REPORT: join(work, 'stale.xml') });

  assert.equal(gate('red', 'api', { TDD_RED_CMD: 'exit 1', TDD_REPORT: join(work, 'stale.xml') }).status, 12);
});

test('RED: without a new or modified test file, the phase fails (code 11)', () => {
  const { status, output } = gate('red', 'api');

  assert.equal(status, 11);
  assert.match(output, /at least one test/);
});

test('RED: the files of the slice are passed to the command', () => {
  const dry = gate('red', 'pwa', { TDD_DRY_RUN: '1', TDD_REPORT: 'pwa/reports/gate-red.xml' }, ['pwa/tests/trial/a.unit.test.ts']);
  assert.match(dry.output, /cd pwa && npx vitest run .*tests\/trial\/a\.unit\.test\.ts/);

  const api = gate('red', 'api', { TDD_DRY_RUN: '1', TDD_REPORT: 'api/reports/gate-red.xml' }, ['api/tests/Shared/FooTest.php']);
  assert.match(api.output, /vendor\/bin\/phpunit --log-junit reports\/gate-red\.xml tests\/Shared\/FooTest\.php/);
});

test('GREEN: passing tests open the REVIEW phase', () => {
  assert.equal(gate('green', 'pwa', { TDD_TEST_CMD: 'echo "37 passed"' }).status, 0);
});

test('GREEN: a failing test stops the workflow before REVIEW (code 20)', () => {
  const { status, output } = gate('green', 'pwa', { TDD_TEST_CMD: 'echo "AssertionError"; exit 1' });

  assert.equal(status, 20);
  assert.match(output, /AssertionError/);
  assert.match(output, /REVIEW phase does not start/);
});

test('green-turn: three counts exit 0, the fourth 1, reset sets it back to zero', () => {
  const env = { TDD_GREEN_TURNS: join(work, 'green-turns') };
  gate('green-turn', 'reset', env);
  assert.deepEqual([1, 2, 3, 4].map(() => gate('green-turn', 'count', env).status), [0, 0, 0, 1]);
  gate('green-turn', 'reset', env);
  assert.equal(readFileSync(env.TDD_GREEN_TURNS, 'utf8').trim(), '0');
  assert.equal(gate('green-turn', 'count', env).status, 0);
});

test('GREEN: a failure writes the output of the suite to TDD_REVIEW_OUTPUT', () => {
  const out = join(work, 'green-last.txt');
  const { status } = gate('green', 'pwa', { TDD_TEST_CMD: 'echo "AssertionError red"; exit 1', TDD_REVIEW_OUTPUT: out });

  assert.equal(status, 20);
  assert.match(readFileSync(out, 'utf8'), /AssertionError red/);
});

test('REVIEW: a review without error passes', () => {
  assert.equal(gate('review', 'api', { TDD_REVIEW_CMD: 'echo "MSI 100%"' }).status, 0);
});

test('REVIEW: a failed review returns the raw output of the tool (code 30)', () => {
  const { status, output } = gate('review', 'api', {
    TDD_REVIEW_CMD: 'echo "src/Probe/Age.php:11 [M] GreaterThanOrEqualTo"; exit 1',
  });

  assert.equal(status, 30);
  assert.match(output, /src\/Probe\/Age\.php:11 \[M\] GreaterThanOrEqualTo/);
});

test('REVIEW: the raw output of the tool is kept in a file for the fixing agent', () => {
  const output = join(work, 'review-last.txt');
  gate('review', 'api', { TDD_REVIEW_CMD: 'echo "src/A.php:3 error"; exit 1', TDD_REVIEW_OUTPUT: output });

  assert.match(readFileSync(output, 'utf8'), /src\/A\.php:3 error/);
});

test('the status of each phase is written to a file that an orchestrator can read', () => {
  const failed = gate('green', 'pwa', { TDD_TEST_CMD: 'exit 1' });
  assert.deepEqual(JSON.parse(readFileSync(failed.statusFile, 'utf8')), { phase: 'green', hexagon: 'pwa', code: 20, message: 'test failed' });

  const ok = gate('review', 'api', { TDD_REVIEW_CMD: 'true' });
  assert.equal(JSON.parse(readFileSync(ok.statusFile, 'utf8')).code, 0);
});

const slice = { TDD_CHANGE: 'circuit', TDD_SLICE: '1.2' };

test('GREEN php: without TDD_CHANGE or TDD_SLICE, code 2', () => {
  assert.equal(gate('green', 'api', { TDD_DRY_RUN: '1', TDD_SLICE: '1.2' }).status, 2);
  assert.equal(gate('green', 'api', { TDD_DRY_RUN: '1', TDD_CHANGE: 'circuit' }).status, 2);
});

test('GREEN php: creates the database before the suite, drops it on exit, ignores the inherited DATABASE_URL', () => {
  const { status, output } = gate('green', 'api', { TDD_DRY_RUN: '1', ...slice, DATABASE_URL: 'postgresql://inherited@postgres:5432/inherited' });
  const lines = output.trim().split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

  assert.equal(status, 0);
  assert.ok(at(/test-database\.sh create circuit 1\.2/) >= 0);
  assert.ok(at(/test-database\.sh create/) < at(/DATABASE_URL=\$\(.*test-database\.sh url circuit 1\.2\).*composer test/));
  assert.ok(at(/composer test/) < at(/test-database\.sh drop circuit 1\.2/));
  assert.doesNotMatch(output, /5432\/inherited\b/);
});

test('the default commands of each hexagon', () => {
  const dry = { TDD_DRY_RUN: '1' };

  assert.match(gate('green', 'api', { ...dry, ...slice }).output, /bin\/stack run api-tools composer test/);
  assert.match(gate('review', 'api', dry).output, /bin\/stack run api-tools composer review/);
  assert.match(gate('green', 'pwa', dry).output, /npm --prefix pwa run test/);
  assert.match(gate('review', 'pwa', dry).output, /npm --prefix pwa run review/);
});

test('the review of api/ mutates only the production files touched', () => {
  const out = gate('review', 'api', { TDD_DRY_RUN: '1' }).output;
  assert.match(out, /composer review:checks/);
  assert.ok(!/--filter=/.test(out) || /--filter=(src|tools)\/[^ ]+\.php/.test(out));
});

test('the review of pwa/ goes through review:checks then a restricted Stryker', () => {
  assert.match(gate('review', 'pwa', { TDD_DRY_RUN: '1' }).output, /npm --prefix pwa run review:checks/);
});

test('Stryker runs from pwa/, where its configuration lives, on the files of the change', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-stryker-'));
  mkdirSync(join(repo, 'pwa', 'src', 'game', 'domain'), { recursive: true });
  writeFileSync(join(repo, 'pwa', 'src', 'game', 'domain', 'x.ts'), 'export {};');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const result = spawnSync('bash', [SCRIPT, 'review', 'pwa'], {
    encoding: 'utf8',
    cwd: repo,
    env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD' },
  });
  const out = `${result.stdout}${result.stderr}`;

  assert.match(out, /env --chdir=pwa VITEST_MAX_WORKERS=1 npx stryker run --concurrency \d+ --mutate 'src\/game\/domain\/x\.ts'/);
  assert.match(out, /npm --prefix pwa run mutation:prepare && .*npx stryker run/);
  rmSync(repo, { recursive: true, force: true });
});

test('Stryker skips a file that declares only interfaces, and does not run when it is alone', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-types-'));
  mkdirSync(join(repo, 'pwa', 'src', 'game', 'application'), { recursive: true });
  writeFileSync(join(repo, 'pwa', 'src', 'game', 'application', 'port.ts'), 'export interface Port {\n  read(): Promise<string>;\n}\n');
  writeFileSync(join(repo, 'pwa', 'src', 'game', 'application', 'tool.ts'), 'export const price = 1;\nexport interface Other {}\n');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const run = () => {
    const result = spawnSync('bash', [SCRIPT, 'review', 'pwa'], {
      encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD' },
    });
    return `${result.stdout}${result.stderr}`;
  };

  const both = run();
  assert.match(both, /--mutate 'src\/game\/application\/tool\.ts'/);
  assert.doesNotMatch(both, /port\.ts/);

  rmSync(join(repo, 'pwa', 'src', 'game', 'application', 'tool.ts'));
  assert.doesNotMatch(run(), /stryker/);
  rmSync(repo, { recursive: true, force: true });
});

test('pwa: the review warns about the excluded files of the pattern when they are alone, and only then', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-skipped-'));
  const application = join(repo, 'pwa', 'src', 'game', 'application');
  mkdirSync(application, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const run = () => {
    const result = spawnSync('bash', [SCRIPT, 'review', 'pwa'], {
      encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD' },
    });
    return `${result.stdout}${result.stderr}`;
  };

  assert.doesNotMatch(run(), /Warning/);

  writeFileSync(join(application, 'port.ts'), 'export interface Port {\n  read(): Promise<string>;\n}\n');
  writeFileSync(join(application, 'types.ts'), 'export type Id = string;\n');
  const alone = run();
  assert.match(alone, /Warning: no mutation testing/);
  assert.match(alone, /pwa\/src\/game\/application\/port\.ts/);
  assert.match(alone, /pwa\/src\/game\/application\/types\.ts/);
  assert.match(alone, /declare only interfaces and types/);
  assert.match(alone, /npm --prefix pwa run review:checks/);

  writeFileSync(join(application, 'tool.ts'), 'export const price = 1;\n');
  assert.doesNotMatch(run(), /Warning/);
  rmSync(repo, { recursive: true, force: true });
});

test('the CPU share becomes a number of cores, and an invalid value is a misuse', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-cpu-'));
  mkdirSync(join(repo, 'api', 'src'), { recursive: true });
  writeFileSync(join(repo, 'api', 'src', 'X.php'), '<?php');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const run = (pct: string) => spawnSync('bash', [SCRIPT, 'review', 'api'], {
    encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: pct },
  });
  const cores = Number(spawnSync('nproc', { encoding: 'utf8' }).stdout);

  assert.match(run('100').stdout, new RegExp(`--threads=${cores} `));
  assert.match(run('1').stdout, /--threads=1 /);
  assert.match(run('').stdout, new RegExp(`--threads=${Math.max(1, Math.floor(cores / 2))} `));
  assert.equal(run('0').status, 2);
  assert.equal(run('x').status, 2);
  rmSync(repo, { recursive: true, force: true });
});

test('the REVIEW runs under nice when TDD_NICE asks for it, and an invalid value is a misuse', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-nice-'));
  mkdirSync(join(repo, 'pwa', 'src'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const run = (nice: string) => spawnSync('bash', [SCRIPT, 'review', 'pwa'], {
    encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_NICE: nice },
  });

  assert.match(run('10').stdout, /^nice -n 10 bash -c .*review:checks/m);
  assert.doesNotMatch(run('').stdout, /nice -n/);
  assert.equal(run('20').status, 2);
  assert.equal(run('x').status, 2);
  rmSync(repo, { recursive: true, force: true });
});

test('the memory cap wraps Stryker, and an invalid value is a misuse', () => {
  const run = (mem: string) => {
    const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-mem-'));
    mkdirSync(join(repo, 'pwa', 'src', 'x', 'domain'), { recursive: true });
    writeFileSync(join(repo, 'pwa', 'src', 'x', 'domain', 'X.ts'), '');
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const out = spawnSync('bash', [SCRIPT, 'review', 'pwa'], {
      encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_MEMORY_MAX: mem },
    });
    rmSync(repo, { recursive: true, force: true });
    return out;
  };

  assert.match(run('4G').stdout, /openspec-tdd-review\.slice MemoryMax=4G && systemd-run .*--slice=openspec-tdd-review\.slice -- env --chdir=pwa VITEST_MAX_WORKERS=1 npx stryker/);
  assert.match(run('').stdout, /MemoryMax=16G /);
  assert.doesNotMatch(run('0').stdout, /MemoryMax/);
  assert.equal(run('lots').status, 2);
  assert.equal(run('8Go').status, 2);
});

test('FINAL: a review that already passed does not run again', () => {
  const ok = gate('review', 'api', { TDD_REVIEW_CMD: 'true' });
  const final = gate('final', 'api', { TDD_STATUS_FILE: ok.statusFile, TDD_REVIEW_CMD: 'echo REVIEW_MARKER; exit 1' });

  assert.equal(final.status, 0);
  assert.match(final.output, /already passed/);
  assert.doesNotMatch(final.output, /REVIEW_MARKER/);
});

test('FINAL: after a failed review, the review runs again and judges', () => {
  const failed = gate('review', 'api', { TDD_REVIEW_CMD: 'exit 1' });
  const final = gate('final', 'api', { TDD_STATUS_FILE: failed.statusFile, TDD_REVIEW_CMD: 'echo REVIEW_MARKER; exit 1' });

  assert.equal(final.status, 30);
  assert.match(final.output, /REVIEW_MARKER/);
});

test('dry-run mode writes no status', () => {
  const { statusFile } = gate('green', 'pwa', { TDD_DRY_RUN: '1' });

  assert.equal(existsSync(statusFile), false);
});

test('an unknown phase or hexagon is a misuse (code 2)', () => {
  assert.equal(gate('blue', 'api').status, 2);
  assert.equal(gate('red', 'mobile').status, 2);
});

test('Infection is limited to the production files of the change and skips mutation testing without them', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-infection-'));
  const review = (): string => {
    const result = spawnSync('bash', [SCRIPT, 'review', 'api'], {
      encoding: 'utf8',
      cwd: repo,
      env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD' },
    });
    return `${result.stdout}${result.stderr}`;
  };
  spawnSync('git', ['init', '-q'], { cwd: repo });

  assert.ok(!/infection/.test(review()), 'no file touched: no mutation testing');

  mkdirSync(join(repo, 'api', 'src', 'Game'), { recursive: true });
  writeFileSync(join(repo, 'api', 'src', 'Game', 'X.php'), '<?php');
  writeFileSync(join(repo, 'api', 'src', 'Game', 'Y.php'), '<?php');

  assert.match(review(), /bin\/infection-review .*--filter=src\/Game\/X\.php,src\/Game\/Y\.php/);
  rmSync(repo, { recursive: true, force: true });
});

test('Infection: TDD_BASE bounds mutation testing to the slice, and an invalid base falls back to main', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-base-'));
  const sh = (command: string): string => spawnSync('bash', ['-c', command], { encoding: 'utf8', cwd: repo }).stdout.trim();
  const commit = (message: string): string =>
    sh(`git add -A && git -c user.email=a@b -c user.name=t -c commit.gpgsign=false commit -qm "${message}" && git rev-parse HEAD`);
  const source = (name: string): void => writeFileSync(join(repo, 'api', 'src', 'Game', name), '<?php\n');
  const review = (base?: string): string => {
    const env: Record<string, string | undefined> = { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: base };
    const result = spawnSync('bash', [SCRIPT, 'review', 'api'], { encoding: 'utf8', cwd: repo, env });
    return `${result.stdout}${result.stderr}`;
  };
  mkdirSync(join(repo, 'api', 'src', 'Game'), { recursive: true });
  sh('git init -q -b main');
  source('Main.php');
  commit('main');
  sh('git checkout -q -b other');
  source('Other.php');
  const elsewhere = commit('other branch');
  sh('git checkout -q -b change main');
  source('A.php');
  const slice1 = commit('slice 1');
  source('B.php');
  commit('slice 2');
  source('C.php');
  const both = /--filter=src\/Game\/A\.php,src\/Game\/B\.php,src\/Game\/C\.php/;

  const slice2 = review(slice1);
  assert.match(slice2, /--filter=src\/Game\/B\.php,src\/Game\/C\.php/);
  assert.doesNotMatch(slice2, /TDD_BASE/);

  const final = review();
  assert.match(final, both);
  assert.doesNotMatch(final, /TDD_BASE/);

  for (const rejected of ['0123456789abcdef0123456789abcdef01234567', elsewhere]) {
    const fallback = review(rejected);
    assert.match(fallback, both);
    assert.ok(fallback.includes(`TDD_BASE "${rejected}" is not an ancestor commit of HEAD: the mutation base is main.`));
  }
  rmSync(repo, { recursive: true, force: true });
});

test('Infection: log deleted before, 2G of memory, guard for skipped mutants after', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-skipped-'));
  mkdirSync(join(repo, 'api', 'src', 'Game'), { recursive: true });
  writeFileSync(join(repo, 'api', 'src', 'Game', 'X.php'), '<?php');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const result = spawnSync('bash', [SCRIPT, 'review', 'api'], {
    encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD' },
  });
  const command = `${result.stdout}${result.stderr}`;
  const at = (pattern: RegExp): number => command.search(pattern);

  assert.ok(at(/rm -f var\/infection\/infection\.log/) >= 0, 'log deleted');
  assert.match(command, /env PHP_INI_SCAN_DIR=:\/app\/infection-php\.d bin\/infection-review --threads=\d+ --filter=src\/Game\/X\.php/);
  assert.ok(at(/rm -f var\/infection\/infection\.log/) < at(/bin\/infection-review /), 'log deleted before');
  rmSync(repo, { recursive: true, force: true });
});

// Per-tool subcommands and review routing (change tdd-par-langage, D5 to D7).
test('check: a failing tool exits with code 30 and keeps its raw output', () => {
  const output = join(work, 'check-last.txt');
  const { status, output: shown } = gate('check', 'php', { TDD_CHECK_CMD: 'echo "src/A.php:3 error"; exit 1', TDD_REVIEW_OUTPUT: output }, ['phpstan']);

  assert.equal(status, 30);
  assert.match(shown, /src\/A\.php:3 error/);
  assert.match(readFileSync(output, 'utf8'), /src\/A\.php:3 error/);
});

test('check: a passing tool passes, and dry-run mode prints the command of each tool', () => {
  assert.equal(gate('check', 'ts', { TDD_CHECK_CMD: 'true' }, ['tsc']).status, 0);

  const dry = { TDD_DRY_RUN: '1' };
  assert.match(gate('check', 'php', dry, ['phpstan']).output, /vendor\/bin\/phpstan analyse/);
  assert.match(gate('check', 'php', dry, ['psalm']).output, /vendor\/bin\/psalm/);
  assert.match(gate('check', 'php', dry, ['phpunit']).output, /composer test/);
  assert.match(gate('check', 'php', dry, ['deptrac']).output, /vendor\/bin\/deptrac analyse/);
  assert.match(gate('check', 'ts', dry, ['tsc']).output, /npm --prefix pwa run typecheck/);
  assert.match(gate('check', 'ts', dry, ['eslint']).output, /npm --prefix pwa run lint/);
  assert.match(gate('check', 'ts', dry, ['vitest']).output, /npm --prefix pwa run test/);
  assert.match(gate('check', 'ts', dry, ['depcruise']).output, /npm --prefix pwa run arch/);
  assert.match(gate('check', 'go', dry, ['govet']).output, /go vet \.\/\.\.\./);
  assert.match(gate('check', 'go', dry, ['gotest']).output, /go test -race/);
});

test('TDD_CHECK_CMD_: replaces a single tool, the others keep their command, TDD_CHECK_CMD stays the fallback', () => {
  const env = { TDD_DRY_RUN: '1', TDD_CHECK_CMD_PHPUNIT: 'echo replace-phpunit' };

  assert.match(gate('check', 'php', env, ['phpunit']).output, /replace-phpunit/);
  assert.match(gate('check', 'php', env, ['phpstan']).output, /vendor\/bin\/phpstan analyse/);
  assert.match(gate('check', 'php', { ...env, TDD_CHECK_CMD: 'echo global' }, ['phpstan']).output, /global/);
  assert.match(gate('check', 'php', { ...env, TDD_CHECK_CMD: 'echo global' }, ['phpunit']).output, /replace-phpunit/);
});

test('check: the language and the tool are validated (code 2), the aliases api and pwa are accepted', () => {
  assert.equal(gate('check', 'cobol', { TDD_CHECK_CMD: 'true' }, ['phpstan']).status, 2);
  assert.equal(gate('check', 'docs', { TDD_CHECK_CMD: 'true' }, ['phpstan']).status, 2);
  assert.equal(gate('check', 'php', { TDD_CHECK_CMD: 'true' }, ['tsc']).status, 2);
  assert.equal(gate('check', 'php', { TDD_CHECK_CMD: 'true' }, []).status, 2);
  assert.equal(gate('check', 'api', { TDD_CHECK_CMD: 'true' }, ['phpstan']).status, 0);
  assert.equal(gate('check', 'pwa', { TDD_CHECK_CMD: 'true' }, ['tsc']).status, 0);
});

test('check: Infection and Stryker are limited to the production files of the change, patterns read from the registry', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-check-'));
  mkdirSync(join(repo, 'api', 'src', 'Game'), { recursive: true });
  writeFileSync(join(repo, 'api', 'src', 'Game', 'X.php'), '<?php');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const dry = (language: string, tool: string) => {
    const result = spawnSync('bash', [SCRIPT, 'check', language, tool], {
      encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD' },
    });
    return `${result.stdout}${result.stderr}`;
  };

  assert.match(dry('php', 'infection'), /bin\/infection-review .*--filter=src\/Game\/X\.php/);
  assert.doesNotMatch(dry('ts', 'stryker'), /stryker run/);
  rmSync(join(repo, 'api'), { recursive: true });
  assert.doesNotMatch(dry('php', 'infection'), /bin\/infection-review/);
  rmSync(repo, { recursive: true, force: true });
});

function classify(tool: string, findings: string, sha: string): { status: number | null; phase: string } {
  const file = join(work, `findings-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, findings);
  const result = spawnSync('bash', [SCRIPT, 'classify', tool, file], { encoding: 'utf8', cwd: work, env: { ...process.env, TDD_FINDINGS_SHA: sha } });
  return { status: result.status, phase: result.stdout.trim() };
}

test('classify: a surviving mutant goes back to RED, everything else to GREEN', () => {
  const sha = join(work, 'sha-a');
  assert.deepEqual(classify('infection', 'Escaped mutants: 1', sha), { status: 0, phase: 'red' });
  assert.equal(classify('stryker', 'Survived 2', join(work, 'sha-b')).phase, 'red');
  for (const tool of ['phpstan', 'psalm', 'phpunit', 'deptrac', 'tsc', 'eslint', 'vitest', 'depcruise', 'govet', 'gotest']) {
    assert.equal(classify(tool, 'error', join(work, `sha-${tool}`)).phase, 'green', tool);
  }
});

test('classify: "Infection a sauté" (output of the project script) goes back to GREEN (faster tests or timeout), not to RED', () => {
  assert.equal(classify('infection', 'Infection a sauté 2 mutants sans les juger.', join(work, 'sha-sautes')).phase, 'green');
  assert.equal(classify('infection', 'Escaped mutants: 1', join(work, 'sha-echappes')).phase, 'red');
});

test('classify: an identical finding picks the other phase once, then stop', () => {
  const sha = join(work, 'sha-repeat');
  assert.equal(classify('infection', 'mutant X', sha).phase, 'red');
  assert.equal(classify('infection', 'mutant X', sha).phase, 'green');
  assert.equal(classify('infection', 'mutant X', sha).phase, 'stop');

  const green = join(work, 'sha-repeat-green');
  assert.equal(classify('tsc', 'TS2322', green).phase, 'green');
  assert.equal(classify('tsc', 'TS2322', green).phase, 'red');
  assert.equal(classify('tsc', 'TS2322', green).phase, 'stop');
});

test('classify: a different finding starts again from the natural phase, and the fourth turn is a stop', () => {
  const sha = join(work, 'sha-cap');
  assert.equal(classify('tsc', 'one', sha).phase, 'green');
  assert.equal(classify('tsc', 'two', sha).phase, 'green');
  assert.equal(classify('tsc', 'three', sha).phase, 'green');
  assert.equal(classify('tsc', 'four', sha).phase, 'stop');
});

test('classify: an unknown tool is a misuse (code 2)', () => {
  assert.equal(classify('nothing', 'x', join(work, 'sha-x')).status, 2);
});

test('red-mutants: tests that pass and target a mutated file open GREEN', () => {
  const review = join(work, 'mutants.txt');
  writeFileSync(review, 'Escaped mutants:\n1) api/src/Game/Age.php:11 [M] GreaterThanOrEqualTo\n');
  const env = { TDD_REVIEW_OUTPUT: review, TDD_RED_CMD: report(3, 0) };

  const ok = gate('red-mutants', 'php', env, ['api/tests/Game/AgeTest.php']);
  assert.equal(ok.status, 0);
  assert.match(ok.output, /mutant/);
});

test('red-mutants: a test that fails (20), outside the mutated file (13), without a report (12) or missing (11) fails the phase', () => {
  const review = join(work, 'mutants2.txt');
  writeFileSync(review, '1) api/src/Game/Age.php:11 [M] GreaterThanOrEqualTo\n');
  const base = { TDD_REVIEW_OUTPUT: review };
  const test = ['api/tests/Game/AgeTest.php'];

  assert.equal(gate('red-mutants', 'php', { ...base, TDD_RED_CMD: report(3, 1) }, test).status, 20);
  assert.equal(gate('red-mutants', 'php', { ...base, TDD_RED_CMD: report(3, 0) }, ['api/tests/Game/OtherTest.php']).status, 13);
  assert.equal(gate('red-mutants', 'php', { ...base, TDD_RED_CMD: 'exit 1' }, test).status, 12);
  assert.equal(gate('red-mutants', 'php', { ...base, TDD_RED_CMD: report(3, 0) }).status, 11);
});

test('red-mutants: pwa/ targets the mutated file by its base name', () => {
  const review = join(work, 'mutants3.txt');
  writeFileSync(review, '#1. [Survived] ArithmeticOperator\nsrc/game/domain/price.ts(4,10)\n');

  assert.equal(gate('red-mutants', 'ts', { TDD_REVIEW_OUTPUT: review, TDD_RED_CMD: report(2, 0) }, ['pwa/tests/game/price.unit.test.ts']).status, 0);
});

test('threejs: default commands of the slice, without mutation testing', () => {
  const dry = { TDD_DRY_RUN: '1' };

  assert.match(gate('green', 'threejs', dry).output, /npm --prefix pwa run test/);
  const review = gate('review', 'threejs', dry).output;
  assert.match(review, /npm --prefix pwa run review:checks/);
  assert.doesNotMatch(review, /stryker/);
});

test('threejs: check runs the ts checks, and stryker is unknown (code 2)', () => {
  const dry = { TDD_DRY_RUN: '1' };

  assert.match(gate('check', 'threejs', dry, ['tsc']).output, /npm --prefix pwa run typecheck/);
  assert.match(gate('check', 'threejs', dry, ['eslint']).output, /npm --prefix pwa run lint/);
  assert.match(gate('check', 'threejs', dry, ['vitest']).output, /npm --prefix pwa run test/);
  assert.match(gate('check', 'threejs', dry, ['depcruise']).output, /npm --prefix pwa run arch/);
  assert.equal(gate('check', 'threejs', { TDD_CHECK_CMD: 'true' }, ['stryker']).status, 2);
});

test('threejs: RED keeps only the .shape.test.ts files, and the ts kind leaves them aside (D3)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-shape-'));
  mkdirSync(join(repo, 'pwa', 'tests'), { recursive: true });
  writeFileSync(join(repo, 'pwa', 'tests', 'a.unit.test.ts'), '');
  writeFileSync(join(repo, 'pwa', 'tests', 'b.shape.test.ts'), '');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const red = (language: string) => {
    const result = spawnSync('bash', [SCRIPT, 'red', language], {
      encoding: 'utf8', cwd: repo, env: { ...process.env, TDD_DRY_RUN: '1', TDD_REPORT: 'pwa/reports/gate-red.xml' },
    });
    return `${result.stdout}${result.stderr}`;
  };

  const threejs = red('threejs');
  assert.match(threejs, /cd pwa && npx vitest run .*tests\/b\.shape\.test\.ts/);
  assert.doesNotMatch(threejs, /a\.unit\.test\.ts/);
  const ts = red('ts');
  assert.match(ts, /tests\/a\.unit\.test\.ts/);
  assert.doesNotMatch(ts, /b\.shape\.test\.ts/);
  rmSync(repo, { recursive: true, force: true });
});

test('classify budget goes back to GREEN', () => {
  const sha = join(work, `sha-${Math.random().toString(36).slice(2)}`);
  const result = spawnSync('bash', [SCRIPT, 'classify', 'budget'], {
    encoding: 'utf8', cwd: work, env: { ...process.env, TDD_FINDINGS_SHA: sha },
  });

  assert.equal(result.stdout.trim(), 'green');
});

function captureRepo(withModel: boolean) {
  const repo = mkdtempSync(join(tmpdir(), 'tdd-gate-capture-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  if (withModel) {
    mkdirSync(join(repo, 'pwa', 'src', 'x', 'infrastructure'), { recursive: true });
    writeFileSync(join(repo, 'pwa', 'src', 'x', 'infrastructure', 'arch-model.ts'), '');
  }
  const bin = join(repo, 'bin');
  mkdirSync(bin);
  for (const name of ['systemd-run', 'systemctl']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const capture = (env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [SCRIPT, 'check', 'threejs', 'capture'], {
      encoding: 'utf8', cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TDD_STATUS_FILE: join(repo, 'status.json'), TDD_REVIEW_OUTPUT: join(repo, 'review.txt'), ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  return { repo, capture };
}

test('threejs: the capture gate exits with 0, 40 or 12 depending on the simulated browser', () => {
  const { repo, capture } = captureRepo(true);

  assert.equal(capture({ TDD_CHECK_CMD: 'exit 0' }).status, 0);
  assert.equal(capture({ TDD_CHECK_CMD: 'echo mismatch; exit 40' }).status, 40);
  assert.equal(capture({ TDD_CHECK_CMD: 'exit 12' }).status, 12);
  assert.equal(capture({ TDD_CHECK_CMD: 'exit 1' }).status, 30);
  rmSync(repo, { recursive: true, force: true });
});

test('threejs: the capture gate passes with no model touched', () => {
  const { repo, capture } = captureRepo(false);

  assert.equal(capture().status, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('threejs: the real capture takes a bounded flock lock and a CPU-capped scope', () => {
  const { repo, capture } = captureRepo(true);
  const { status, output } = capture({ TDD_DRY_RUN: '1', TDD_CPU_PERCENT: '50' });

  assert.equal(status, 0);
  assert.match(output, /flock -w \d+ -E 12 \S*model-capture\.lock/);
  assert.match(output, /--slice=openspec-tdd-review\.slice -p CPUQuota=\d+%/);
  assert.match(output, /capture-modele\.mts \S*arch-model\.ts/);
  rmSync(repo, { recursive: true, force: true });
});

test('classify capture writes art-direction without touching the turn counter', () => {
  const sha = join(work, `sha-${Math.random().toString(36).slice(2)}`);
  const result = spawnSync('bash', [SCRIPT, 'classify', 'capture'], {
    encoding: 'utf8', cwd: work, env: { ...process.env, TDD_FINDINGS_SHA: sha },
  });

  assert.equal(result.stdout.trim(), 'art-direction');
  assert.equal(existsSync(sha), false);
});

// Proof store (portes-preuves-et-perimetre, D2 to D5): the tests marked needsZpm run the real zpm.
const hasZpm = spawnSync('zpm', ['version']).status === 0;
const needsZpm = { skip: hasZpm ? false : 'zpm is not in the PATH' };
type Proof = { O: string; P: string; E: string; T: number; S: string };
// Proofs of the .zpm/ base of a repository, and folder of its kept reports.
function store(dir: string) {
  const reports = join(dir, '.git', 'awf', 'preuves');
  const proofs = (): Proof[] => {
    if (!existsSync(join(dir, '.zpm'))) return [];
    const r = spawnSync('zpm', ['query-logic', '--goal', 'preuve(O, P, E, T, S)', '--format', 'json'], { cwd: dir, encoding: 'utf8' });
    return JSON.parse(JSON.parse(r.stdout)[0]);
  };
  return { reports, proofs };
}
// PATH without zpm, and a replacement zpm that logs its subcommand to calls.log.
const pathWithoutZpm = (process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, 'zpm'))).join(':');
function fakeZpm(answers: { status?: string; query?: string; remember?: string } = {}) {
  const bin = mkdtempSync(join(work, 'zpm-'));
  const log = join(bin, 'calls.log');
  const active = `printf '%s\\n' '${JSON.stringify(['status: active\ndir: /x'])}'`;
  writeFileSync(join(bin, 'zpm'), `#!/usr/bin/env bash
echo "$1" >> "${log}"
case "$1" in
  init) mkdir -p .zpm ;;
  get-persistence-status) ${answers.status ?? active} ;;
  query-logic) ${answers.query ?? `echo '["[]"]'`} ;;
  remember-fact) ${answers.remember ?? 'echo "Asserted: x"'} ;;
esac
`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { env: { PATH: `${bin}:${pathWithoutZpm}` }, calls };
}

// Reuse of a passed suite through a pass proof (portes-preuves-et-perimetre, D2).
function suiteRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tdd-suite-'));
  const sh = (cmd: string) => spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
  mkdirSync(join(dir, 'pwa', 'src'), { recursive: true });
  mkdirSync(join(dir, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(dir, 'pwa', 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'openspec', 'changes', 'tasks.md'), 'x\n');
  sh('git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm init');
  const counter = join(dir, 'runs.txt');
  const run = (extra: Record<string, string> = {}, cmd = `echo x >> ${counter}; mkdir -p pwa/reports; echo '<testsuites/>' > pwa/reports/junit.xml`) =>
    spawnSync('bash', [SCRIPT, 'green', 'pwa'], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, TDD_TEST_CMD: cmd, TDD_STATUS_FILE: join(dir, 'status.json'), ...extra },
    });
  const runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, run, runs, ...store(dir) };
}

test('suite: unchanged tree, the second run reuses the suite', needsZpm, () => {
  const { run, runs, proofs } = suiteRepo();
  assert.equal(run().status, 0);
  assert.deepEqual(proofs().map(({ O, P }) => ({ O, P })), [{ O: 'suite', P: 'complet' }]);
  const second = run();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /suite reused: fingerprint [0-9a-f]{8}/);
  assert.equal(runs(), 1);
});

test('suite: a modified or untracked file in the scope runs the suite again', needsZpm, () => {
  const { dir, run, runs } = suiteRepo();
  run();
  writeFileSync(join(dir, 'pwa', 'src', 'a.ts'), 'export const a = 2;\n');
  run();
  assert.equal(runs(), 2);
  writeFileSync(join(dir, 'pwa', 'src', 'new.ts'), 'export const b = 1;\n');
  run();
  assert.equal(runs(), 3);
});

test('suite: a file outside the scope leaves the fingerprint unchanged', needsZpm, () => {
  const { dir, run, runs } = suiteRepo();
  run();
  writeFileSync(join(dir, 'openspec', 'changes', 'tasks.md'), 'modified\n');
  writeFileSync(join(dir, 'openspec', 'changes', 'new.md'), 'new\n');
  assert.match(run().stdout, /suite reused/);
  assert.equal(runs(), 1);
});

test('suite: an unreadable proof or a missing kept report runs the suite again', needsZpm, () => {
  const { run, runs, reports } = suiteRepo();
  run();
  run(fakeZpm({ query: 'echo "{not json"' }).env);
  assert.equal(runs(), 2);
  rmSync(reports, { recursive: true });
  run();
  assert.equal(runs(), 3);
});

test('suite: a JUnit report missing from the worktree is restored from the kept report', needsZpm, () => {
  const { dir, run, runs } = suiteRepo();
  run();
  rmSync(join(dir, 'pwa', 'reports', 'junit.xml'));
  assert.match(run().stdout, /suite reused/);
  assert.equal(runs(), 1);
  assert.equal(readFileSync(join(dir, 'pwa', 'reports', 'junit.xml'), 'utf8'), '<testsuites/>\n');
});

test('suite: a failed suite writes no proof', needsZpm, () => {
  const { dir, run, proofs } = suiteRepo();
  run();
  const before = proofs();
  assert.equal(before.length, 1);
  writeFileSync(join(dir, 'pwa', 'src', 'a.ts'), 'export const a = 3;\n');
  assert.equal(run({}, 'exit 1').status, 20);
  assert.deepEqual(proofs(), before);
});

test('suite: the record of an earlier gate is not read', needsZpm, () => {
  const { dir, run, runs, proofs, reports } = suiteRepo();
  run();
  const [{ E }] = proofs();
  rmSync(join(dir, '.zpm'), { recursive: true });
  rmSync(reports, { recursive: true });
  mkdirSync(join(dir, '.awf', 'status'), { recursive: true });
  writeFileSync(join(dir, '.awf', 'status', 'suite-ts.json'), JSON.stringify({ empreinte: E, suite: 'tests', rapport: 'pwa/reports/junit.xml' }));
  assert.doesNotMatch(run().stdout, /suite reused/);
  assert.equal(runs(), 2);
});

test('suite: TDD_FORCE=1 runs the suite again despite a matching proof', needsZpm, () => {
  const { run, runs } = suiteRepo();
  run();
  const forced = run({ TDD_FORCE: '1' });
  assert.doesNotMatch(forced.stdout, /suite reused/);
  assert.equal(runs(), 2);
});

test('suite: a file read by the tests outside pwa/ (contracts/) invalidates the fingerprint', needsZpm, () => {
  const { dir, run, runs } = suiteRepo();
  run();
  mkdirSync(join(dir, 'contracts'), { recursive: true });
  writeFileSync(join(dir, 'contracts', 'c.json'), '{}');
  run();
  assert.equal(runs(), 2);
});

// Infection runs again only the test methods that cover the line (portes-plus-rapides, D3).
test('infection: the gate command keeps its full initial test run, without --only-covering-test-cases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdd-infection-'));
  mkdirSync(join(dir, 'api', 'src', 'Game'), { recursive: true });
  writeFileSync(join(dir, 'api', 'src', 'Game', 'X.php'), '<?php');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('bash', [SCRIPT, 'check', 'php', 'infection'], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, TDD_CPU_PERCENT: '100', TDD_BASE: 'HEAD', TDD_DRY_RUN: '1', TDD_STATUS_FILE: join(dir, 'status.json') },
  }).stdout;

  assert.match(out, /bin\/infection-review .*--filter=src\/Game\/X\.php/);
  assert.doesNotMatch(out, /--only-covering-test-cases|--skip-initial-tests/);
});

test('review: the architecture runs before the suite, and the GREEN suite is reused', needsZpm, () => {
  const { dir, run, runs } = suiteRepo();
  const order = join(dir, 'order.txt');
  const suite = `echo suite >> ${order}; echo x >> ${join(dir, 'runs.txt')}; mkdir -p pwa/reports; echo '<testsuites/>' > pwa/reports/junit.xml`;
  assert.equal(run({}, suite).status, 0);
  const review = spawnSync('bash', [SCRIPT, 'review', 'pwa'], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      TDD_STATUS_FILE: join(dir, 'status.json'),
      TDD_REVIEW_OUTPUT: join(dir, 'review.txt'),
      TDD_CHECK_CMD_TSC: `echo tsc >> ${order}`,
      TDD_CHECK_CMD_ESLINT: `echo eslint >> ${order}`,
      TDD_CHECK_CMD_DEPCRUISE: `echo depcruise >> ${order}`,
      TDD_CHECK_CMD_VITEST: suite,
    },
  });

  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.match(review.stdout, /suite reused/);
  assert.equal(runs(), 1);
  assert.deepEqual(readFileSync(order, 'utf8').trim().split('\n'), ['suite', 'tsc', 'eslint', 'depcruise']);
});

// REVIEW php: a database of its own for the REVIEW (change tdd-review-base-isolee).

test('REVIEW php: command emitted with TDD_SLICE (revue_<slice>), without it (revue_finale), inherited URL ignored', () => {
  const withSlice = gate('review', 'api', { TDD_DRY_RUN: '1', ...slice, DATABASE_URL: 'postgresql://inherited@postgres:5432/inherited' });
  const lines = withSlice.output.trim().split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

  assert.equal(withSlice.status, 0);
  assert.ok(at(/test-database\.sh create circuit revue_1\.2/) >= 0);
  assert.ok(at(/test-database\.sh create/) < at(/DATABASE_URL=\$\(.*test-database\.sh url circuit revue_1\.2\).*composer review:checks/));
  assert.ok(at(/composer review:checks/) < at(/test-database\.sh drop circuit revue_1\.2/));
  assert.doesNotMatch(withSlice.output, /5432\/inherited\b/);
  assert.match(gate('review', 'api', { TDD_DRY_RUN: '1', TDD_CHANGE: 'circuit' }).output, /test-database\.sh create circuit revue_finale/);
});

test('REVIEW php: without TDD_CHANGE, the change is the worktree folder', () => {
  const wt = join(mkdtempSync(join(work, 'wt-')), 'circuit--t2');
  mkdirSync(wt);
  symlinkSync(join(FIXTURE, '.awf'), join(wt, '.awf'));
  const { status, output } = gate('review', 'api', { TDD_DRY_RUN: '1', OPENSPEC_ROOT: wt });

  assert.equal(status, 0);
  assert.match(output, /test-database\.sh create circuit--t2 revue_finale/);
});

test('header: code 50 applies to GREEN, REVIEW and check, and the REVIEW database is described there', () => {
  const header = readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => line.startsWith('#')).join('\n');
  assert.match(header, /50 {2}GREEN, REVIEW and check php: test database unavailable/);
  assert.match(header, /`database_url_env` in the registry \(DATABASE_URL by default\)/);
  assert.match(header, /label revue_<slice>, or revue_finale without a slice/);
});

// Lease of `check`: the gate calls review-slots.sh; these tests describe the observable behaviour of the gate (task 1.3).
// Each trial has its own runtime folder, under the working folder of the test.
const sleepSync = (seconds: number) => spawnSync('sleep', [String(seconds)]);
function waitFor(condition: () => boolean, seconds = 15) {
  for (let n = 0; n < seconds * 10 && !condition(); n++) sleepSync(0.1);
  assert.ok(condition(), 'condition not reached in time');
}
function runtime() {
  const dir = mkdtempSync(join(work, 'rt-'));
  return {
    dir,
    tickets: () => (existsSync(join(dir, 'openspec-tdd-review-queue')) ? spawnSync('bash', ['-c', `ls "${join(dir, 'openspec-tdd-review-queue')}"/*.ticket 2>/dev/null | wc -l`], { encoding: 'utf8' }).stdout.trim() : '0'),
    env: (extra: Record<string, string> = {}) => ({ XDG_RUNTIME_DIR: dir, TDD_REVIEW_SLOTS: '1', TDD_REVIEW_SLOT_STEP: '0.2', ...extra }),
  };
}
// Fake holder of a slot for `seconds`; kill() releases it at once.
function holdSlot(dir: string, i: number, seconds: number) {
  const lock = join(dir, `openspec-tdd-review-slot-${i}.lock`);
  const holder = spawn('bash', ['-c', `exec 9>"${lock}"; flock -n 9 && exec sleep ${seconds}`], { stdio: 'ignore' });
  waitFor(() => existsSync(lock) && spawnSync('bash', ['-c', `exec 9>"${lock}"; flock -n 9`]).status !== 0);
  return holder;
}
const slotHeld = (rt: ReturnType<typeof runtime>) => spawnSync('bash', ['-c', `exec 9>>"${join(rt.dir, 'openspec-tdd-review-slot-1.lock')}"; flock -n 9`]).status !== 0;
// Lease of `check` php: REVIEW database created once, dropped by the keeper. The gate copied to a throwaway folder
// finds there a replaced test-database.sh that logs its calls.
function leaseDb(failCreate = false) {
  const dir = mkdtempSync(join(work, 'ldb-'));
  const log = join(dir, 'calls.log');
  const scripts = join(dir, '.awf', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const f of ['tdd-gate.sh', 'review-slots.sh', 'openspec-tasks.sh', 'openspec-tasks.mts']) copyFileSync(join(dirname(SCRIPT), f), join(scripts, f));
  copyFileSync(join(FIXTURE, '.awf', 'languages.yaml'), join(dir, '.awf', 'languages.yaml'));
  writeFileSync(join(scripts, 'test-database.sh'), `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  url) echo "postgresql://fake/$2__$3" ;;
  create) ${failCreate ? 'exit 50' : 'true'} ;;
esac
`, { mode: 0o755 });
  const rt = runtime();
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const tool = (name: string, extra: Record<string, string> = {}) => {
    const statusFile = join(dir, `st-${Math.random()}.json`);
    const r = spawnSync('bash', [join(scripts, 'tdd-gate.sh'), 'check', 'api', name], {
      encoding: 'utf8', cwd: work,
      env: { ...process.env, ...rt.env({ OPENSPEC_ROOT: dir, TDD_CHANGE: 'circuit', TDD_STATUS_FILE: statusFile, TDD_REVIEW_OUTPUT: join(dir, 'out.txt'), TDD_CHECK_CMD: `echo "$DATABASE_URL" >> "${dir}/urls"`, TDD_REVIEW_LEASE_IDLE: '30', TDD_REVIEW_LEASE_POLL: '0.2', ...extra }) },
    });
    return { status: r.status, statusFile };
  };
  return { dir, rt, calls, tool, urls: () => readFileSync(join(dir, 'urls'), 'utf8').trim().split('\n') };
}
const count = (calls: string[], verb: string) => calls.filter((c) => c.startsWith(`${verb} `)).length;

test('php lease: a single creation for five tools, one drop at the last, URL recomputed per tool', () => {
  const { rt, calls, tool, urls } = leaseDb();
  for (const name of ['phpstan', 'psalm', 'phpunit', 'deptrac']) assert.equal(tool(name).status, 0);
  assert.equal(count(calls(), 'create'), 1);
  assert.equal(count(calls(), 'drop'), 0);
  assert.equal(tool('infection').status, 0);
  waitFor(() => count(calls(), 'drop') === 1);
  assert.equal(count(calls(), 'create'), 1);
  assert.equal(count(calls(), 'url'), 5);
  assert.deepEqual(urls(), Array(5).fill('postgresql://fake/circuit__revue_finale'));
  assert.equal(slotHeld(rt), false);
});

test('php lease: the first failure drops the database', () => {
  const { calls, tool } = leaseDb();
  assert.equal(tool('phpstan', { TDD_CHECK_CMD: 'exit 1' }).status, 30);
  assert.equal(count(calls(), 'create'), 1);
  assert.equal(count(calls(), 'drop'), 1);
});

test('php lease: without a new tool, the database is dropped after TDD_REVIEW_LEASE_IDLE', () => {
  const { calls, tool } = leaseDb();
  assert.equal(tool('phpstan', { TDD_REVIEW_LEASE_IDLE: '1' }).status, 0);
  waitFor(() => count(calls(), 'drop') === 1);
});

test('php lease: slot not obtained, no creation', () => {
  const { dir, rt, calls, tool } = leaseDb();
  const holder = holdSlot(rt.dir, 1, 8);
  try {
    assert.equal(tool('phpstan', { TDD_REVIEW_SLOT_TIMEOUT: '1' }).status, 13);
    assert.deepEqual(calls(), []);
    assert.ok(!existsSync(join(dir, 'urls')));
  } finally { holder.kill(); }
});

test('php lease: create fails, slot released, code 50 and no keeper', () => {
  const { rt, calls, tool } = leaseDb(true);
  const { status, statusFile } = tool('phpstan', { TDD_REVIEW_LEASE_IDLE: '1' });
  assert.equal(status, 50);
  assert.equal(JSON.parse(readFileSync(statusFile, 'utf8')).code, 50);
  assert.equal(slotHeld(rt), false);
  sleepSync(2.5); // a keeper would have dropped the database after 1 s of inactivity
  assert.deepEqual(calls().map((c) => c.split(' ')[0]), ['create']);
});


// Emitted commands (task 2.1 of tdd-gate-decoupe): each phase and each `check` tool, for each language, in dry run,
// in a clean throwaway repository (no file changed): the list pins what the language registry and the gate compose.
// To update it after an intended change: UPDATE_SNAPSHOT=1 node --test --test-name-pattern="commands" .awf/scripts/tdd-gate.test.mts
test('commands: the commands emitted by each phase and each tool, for each language, do not change', () => {
  const dir = mkdtempSync(join(work, 'cmd-'));
  const scripts = join(dir, '.awf', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const f of ['tdd-gate.sh', 'review-slots.sh', 'openspec-tasks.sh', 'openspec-tasks.mts']) copyFileSync(join(dirname(SCRIPT), f), join(scripts, f));
  copyFileSync(join(FIXTURE, '.awf', 'scripts', 'test-database.sh'), join(scripts, 'test-database.sh'));
  copyFileSync(join(FIXTURE, '.awf', 'languages.yaml'), join(dir, '.awf', 'languages.yaml'));
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']]) spawnSync('git', args, { cwd: dir });
  const env = { ...process.env, OPENSPEC_ROOT: dir, TDD_DRY_RUN: '1', TDD_CHANGE: 'chg', TDD_SLICE: '1.2 une tranche', XDG_RUNTIME_DIR: mkdtempSync(join(work, 'rtc-')), TDD_REVIEW_SLOTS: '2', TDD_STATUS_FILE: '/dev/null', TDD_REVIEW_OUTPUT: '/dev/null' };
  const registry = JSON.parse(spawnSync('bash', [join(scripts, 'openspec-tasks.sh'), 'languages'], { cwd: dir, env, encoding: 'utf8' }).stdout) as Record<string, { checks: Record<string, string> }>;
  const real: Record<string, string> = { api: 'php', pwa: 'ts' };
  let output = '';
  for (const lang of ['php', 'ts', 'threejs', 'go', 'api', 'pwa']) {
    const tools = Object.keys(registry[real[lang] ?? lang]?.checks ?? {});
    for (const args of [['green', lang], ['review', lang], ['final', lang], ...tools.map((tool) => ['check', lang, tool])]) {
      const r = spawnSync('bash', ['-c', 'bash "$0" "$@" 2>&1', join(scripts, 'tdd-gate.sh'), ...args], { cwd: dir, env, encoding: 'utf8' });
      output += `### ${args.join(' ')}\n${r.stdout}rc=${r.status}\n`;
    }
  }
  output = output.replaceAll(scripts, '.awf/scripts').replaceAll('\\ ', ' ');
  const fixture = join(dirname(SCRIPT), 'fixtures', 'tdd-gate-commands.txt');
  if (process.env.UPDATE_SNAPSHOT === '1') writeFileSync(fixture, output);
  assert.equal(output, readFileSync(fixture, 'utf8'));
});

test('queue: tdd-gate.sh delegates to review-slots.sh queue, read only, code 0', () => {
  const rt = mkdtempSync(join(work, 'rtq-'));
  const r = spawnSync('bash', [SCRIPT, 'queue'], { encoding: 'utf8', cwd: work, env: { ...process.env, XDG_RUNTIME_DIR: rt, TDD_REVIEW_SLOTS: '2' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Slots \(2 at most\):/);
  assert.match(r.stdout, /Queue:/);
  assert.ok(!existsSync(join(rt, 'openspec-tdd-review-queue')), 'queue drops no ticket');
});

// Timings (portes-preuves-et-perimetre, D1): one JSON line per phase in TDD_TIMINGS_FILE.
type Timing = { phase: string; language: string; tool: string; seconds: number; wait: number; code: number; reused: boolean };
function timings() {
  const file = join(mkdtempSync(join(work, 'timings-')), 'tdd-gate-timings.jsonl');
  const lines = (): Timing[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { file, lines, env: { TDD_TIMINGS_FILE: file } };
}

test('timings: red, green, review, check and red-mutants each append a line', () => {
  const { lines, env } = timings();
  const review = join(work, 'mutants-timings.txt');
  writeFileSync(review, '1) api/src/Game/Age.php:11 [M] GreaterThanOrEqualTo\n');

  gate('red', 'api', { ...env, TDD_RED_CMD: report(3, 0) });
  gate('green', 'pwa', { ...env, TDD_TEST_CMD: 'sleep 0.3; exit 1' });
  gate('review', 'go', { ...env, TDD_REVIEW_CMD: 'true' });
  gate('check', 'pwa', { ...env, TDD_CHECK_CMD: 'true' }, ['tsc']);
  gate('red-mutants', 'php', { ...env, TDD_REVIEW_OUTPUT: review, TDD_RED_CMD: report(3, 0) }, ['api/tests/Game/AgeTest.php']);

  const written = lines();
  assert.deepEqual(
    written.map(({ phase, language, tool, code, reused }) => ({ phase, language, tool, code, reused })),
    [
      { phase: 'red', language: 'php', tool: '', code: 10, reused: false },
      { phase: 'green', language: 'ts', tool: '', code: 20, reused: false },
      { phase: 'review', language: 'go', tool: '', code: 0, reused: false },
      { phase: 'check', language: 'ts', tool: 'tsc', code: 0, reused: false },
      { phase: 'red-mutants', language: 'php', tool: '', code: 0, reused: false },
    ],
  );
  assert.deepEqual(Object.keys(written[3]), ['phase', 'language', 'tool', 'seconds', 'wait', 'code', 'reused']);
  assert.ok(written[1].seconds >= 0.3 && written[1].seconds < 30, `green duration: ${written[1].seconds}`);
  assert.ok(written.every((l) => l.wait < 1), 'a free slot is taken without waiting');
});

test('timings: a misuse (code 2) writes no line', () => {
  const { file, env } = timings();

  assert.equal(gate('check', 'pwa', env, ['unknown']).status, 2);
  assert.ok(!existsSync(file));
});

test('timings: under a locale with a decimal comma, the line stays JSON', () => {
  const { lines, env } = timings();
  gate('green', 'pwa', { ...env, TDD_TEST_CMD: 'true', LC_ALL: 'fr_FR.UTF-8', LC_NUMERIC: 'fr_FR.UTF-8' });

  assert.equal(lines().length, 1);
  assert.equal(typeof lines()[0].seconds, 'number');
});

test('timings: the wait for a slot is separate from the run, and the review adds up those of its tools', () => {
  const { lines, env } = timings();
  const rt = runtime();
  const holder = holdSlot(rt.dir, 1, 1.5);
  const r = gate('review', 'pwa', { ...env, ...rt.env(), TDD_CHECK_CMD: 'true', TDD_REVIEW_OUTPUT: join(rt.dir, 'review.txt') });
  holder.kill();

  assert.equal(r.status, 0, r.output);
  const written = lines();
  const checks = written.filter((l) => l.phase === 'check');
  const review = written.filter((l) => l.phase === 'review');
  assert.deepEqual(checks.map((l) => l.tool), ['tsc', 'eslint', 'depcruise', 'vitest', 'stryker']);
  assert.ok(checks[0].wait >= 1 && checks[0].wait < 10, `tsc wait: ${checks[0].wait}`);
  assert.ok(checks[0].seconds < checks[0].wait + 1, 'the run does not count the wait');
  assert.ok(checks.slice(1).every((l) => l.wait === 0), 'a reused lease does not wait');
  assert.equal(review.length, 1);
  assert.equal(review[0].wait, checks[0].wait);
  assert.equal(review[0].tool, '');
});

test('timings: the single-command review phase records the wait for its slot', () => {
  const { lines, env } = timings();
  const rt = runtime();
  const holder = holdSlot(rt.dir, 1, 1.5);
  const r = gate('review', 'go', { ...env, ...rt.env(), TDD_REVIEW_CMD: 'true' });
  holder.kill();

  assert.equal(r.status, 0, r.output);
  assert.ok(lines()[0].wait >= 1, `wait: ${lines()[0].wait}`);
});

test('timings: a reused suite sets reused to true', needsZpm, () => {
  const { dir, run } = suiteRepo();
  run();
  run();
  const written: Timing[] = readFileSync(join(dir, '.awf', 'status', 'tdd-gate-timings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  assert.deepEqual(written.map((l) => l.reused), [false, true]);
});

test('timings: dry-run mode writes no line', () => {
  const { file, env } = timings();
  const dry = { ...env, TDD_DRY_RUN: '1' };
  gate('red', 'pwa', dry, ['pwa/tests/trial/a.unit.test.ts']);
  gate('green', 'pwa', dry);
  gate('review', 'pwa', dry);
  gate('check', 'pwa', dry, ['tsc']);
  gate('red-mutants', 'pwa', dry, ['pwa/tests/trial/a.unit.test.ts']);

  assert.ok(!existsSync(file));
});

test('timings: a read-only status folder keeps the exit code of the phase', () => {
  const locked = mkdtempSync(join(work, 'read-only-'));
  spawnSync('chmod', ['555', locked]);
  const env = { TDD_TIMINGS_FILE: join(locked, 'status', 'tdd-gate-timings.jsonl') };
  const failed = gate('green', 'pwa', { ...env, TDD_TEST_CMD: 'exit 1' });
  const ok = gate('check', 'pwa', { ...env, TDD_CHECK_CMD: 'true' }, ['tsc']);
  spawnSync('chmod', ['755', locked]);

  assert.equal(failed.status, 20);
  assert.equal(ok.status, 0);
  assert.match(failed.output, /The timings are not written/);
  assert.ok(!existsSync(join(locked, 'status')));
});

// Pass proofs of the `check` tools (portes-preuves-et-perimetre, D2 to D5), in a throwaway repository whose .zpm/ base
// and kept reports belong to the trial.
function proofRepo(root = tmpdir()) {
  const dir = mkdtempSync(join(root, 'tdd-proofs-'));
  const sh = (cmd: string) => spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
  mkdirSync(join(dir, 'pwa', 'src'), { recursive: true });
  mkdirSync(join(dir, 'api', 'src', 'Game'), { recursive: true });
  writeFileSync(join(dir, 'pwa', 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'api', 'src', 'Game', 'Base.php'), '<?php\n');
  sh('git init -q -b main && git add -A && git -c user.email=a@b -c user.name=t commit -qm init');
  const rt = runtime();
  const stack = join(rt.dir, 'stack');
  writeFileSync(stack, '#!/usr/bin/env bash\ntrue\n', { mode: 0o755 });
  const counter = join(dir, 'runs.txt');
  const count = `echo x >> ${counter}`;
  const env = (extra: Record<string, string>) => ({
    ...process.env, ...rt.env(), STACK: stack, TDD_CHANGE: 'proofs', TDD_SLICE: '1.1', TDD_REVIEW_LEASE_IDLE: '1', TDD_REVIEW_LEASE_POLL: '0.2',
    TDD_STATUS_FILE: join(dir, 'status.json'), TDD_REVIEW_OUTPUT: join(dir, 'out.txt'), TDD_TIMINGS_FILE: join(dir, 'timings.jsonl'), ...extra,
  });
  // check(language, tool, variables, command): a null command keeps the one of the registry.
  const check = (language: string, tool: string, extra: Record<string, string> = {}, cmd: string | null = count) => {
    const r = spawnSync('bash', [SCRIPT, 'check', language, tool], {
      encoding: 'utf8', cwd: dir, env: env({ ...(cmd === null ? {} : { [`TDD_CHECK_CMD_${tool.toUpperCase()}`]: cmd }), ...extra }),
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const green = (language: string, cmd: string, extra: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT, 'green', language], { encoding: 'utf8', cwd: dir, env: env({ TDD_TEST_CMD: cmd, ...extra }) });
  const runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0);
  const lastTiming = (): Timing => JSON.parse(readFileSync(join(dir, 'timings.jsonl'), 'utf8').trim().split('\n').at(-1) ?? '{}');
  after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sh, env, check, green, runs, count, lastTiming, ...store(dir) };
}
const sha256 = (file: string) => spawnSync('sha256sum', [file], { encoding: 'utf8' }).stdout.split(' ')[0];

test('proofs: a passing tool writes its proof and its report, then does not run again on the same tree', needsZpm, () => {
  const { dir, check, runs, proofs, reports, lastTiming } = proofRepo();
  assert.equal(check('ts', 'tsc', {}, `echo x >> ${join(dir, 'runs.txt')}; echo "tsc without error"`).status, 0);
  const [proof, ...others] = proofs();
  assert.deepEqual(others, []);
  assert.deepEqual({ O: proof.O, P: proof.P }, { O: 'tsc', P: 'complet' });
  assert.match(proof.E, /^[0-9a-f]{64}$/);
  assert.ok(Math.abs(proof.T - Date.now() / 1000) < 120, `timestamp: ${proof.T}`);
  assert.equal(readFileSync(join(reports, proof.S), 'utf8'), 'tsc without error\n');
  assert.equal(sha256(join(reports, proof.S)), proof.S);
  assert.equal(lastTiming().reused, false);

  const second = check('ts', 'tsc', {}, `echo x >> ${join(dir, 'runs.txt')}; echo "tsc without error"`);
  assert.equal(second.status, 0);
  assert.match(second.output, new RegExp(`^proof reused: tsc, fingerprint ${proof.E.slice(0, 8)}$`, 'm'));
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), `proof reused: tsc, fingerprint ${proof.E.slice(0, 8)}\n`);
  assert.equal(runs(), 1);
  assert.deepEqual({ tool: lastTiming().tool, reused: lastTiming().reused, wait: lastTiming().wait, code: lastTiming().code }, { tool: 'tsc', reused: true, wait: 0, code: 0 });
  assert.equal(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')).message, 'tsc ok');
});

test('proofs: two worktrees of the same tree share the base of the main repository', needsZpm, () => {
  const parent = mkdtempSync(join(tmpdir(), 'tdd-parent-'));
  after(() => rmSync(parent, { recursive: true, force: true }));
  spawnSync('zpm', ['init'], { cwd: parent });
  const digest = () => spawnSync('bash', ['-c', 'find .zpm -type f | sort | xargs -r sha256sum'], { cwd: parent, encoding: 'utf8' }).stdout;
  const before = digest();
  const { dir, sh, env, runs, proofs, reports } = proofRepo(parent);
  writeFileSync(join(dir, '.gitignore'), 'reports/\n');
  sh('git add -A && git -c user.email=a@b -c user.name=t commit -qm ignore && git worktree add -q ../one && git worktree add -q ../two');
  const [one, two] = [join(parent, 'one'), join(parent, 'two')];
  const flag = join(parent, 'failure');
  const cmds = Object.fromEntries(['tsc', 'eslint', 'depcruise', 'vitest', 'stryker'].map((tool) => [
    `TDD_CHECK_CMD_${tool.toUpperCase()}`, `echo x >> ${join(dir, 'runs.txt')}; mkdir -p pwa/reports; echo '<testsuites/>' > pwa/reports/junit.xml; echo "${tool} ok"; test ! -e ${flag}`,
  ]));
  const gate = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd, env: env({ ...cmds, ...extra }) });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };

  const first = gate(one, ['review', 'pwa']);
  assert.equal(first.status, 0, first.output);
  const ran = runs();
  assert.ok(ran >= 4, `tools run in the first worktree: ${ran}`);

  const rt = runtime();
  const second = gate(two, ['review', 'pwa'], rt.env());
  assert.equal(second.status, 0, second.output);
  assert.equal(runs(), ran, second.output);
  assert.ok(!existsSync(join(rt.dir, 'openspec-tdd-review-queue')), 'a REVIEW whose tools are all reused drops no ticket');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: two, encoding: 'utf8' }).stdout, '');

  const tsc = proofs().find((p) => p.O === 'tsc');
  assert.ok(tsc, 'the proof of tsc is in the base of the main repository');
  writeFileSync(join(reports, tsc.S), 'altered report\n');
  writeFileSync(flag, '');
  const third = gate(two, ['check', 'ts', 'tsc']);
  assert.equal(third.status, 30, third.output);
  assert.equal(runs(), ran + 1);
  assert.ok(!proofs().some((p) => p.O === 'tsc'), 'the proof with the altered report is removed');

  assert.ok(!existsSync(join(one, '.zpm')) && !existsSync(join(two, '.zpm')), 'no base in the worktrees');
  assert.equal(digest(), before, 'the base of the parent folder stays intact');
});

test('proofs: a failing tool leaves no proof', needsZpm, () => {
  const { check, proofs } = proofRepo();
  assert.equal(check('ts', 'eslint', {}, 'echo "lint error"; exit 1').status, 30);
  assert.deepEqual(proofs(), []);
});

test('proofs: a modified file of the scope runs the tool again', needsZpm, () => {
  const { dir, check, runs, proofs } = proofRepo();
  check('ts', 'tsc');
  writeFileSync(join(dir, 'pwa', 'src', 'a.ts'), 'export const a = 2;\n');
  const second = check('ts', 'tsc');
  assert.doesNotMatch(second.output, /proof reused/);
  assert.equal(runs(), 2);
  assert.equal(new Set(proofs().map((p) => p.E)).size, 2);
});

test('proofs: TDD_FORCE=1 runs the tool again and rewrites the proof', needsZpm, () => {
  const { check, runs, proofs, count } = proofRepo();
  const cmd = `${count}; date +%s%N`;
  check('ts', 'tsc', {}, cmd);
  const [first] = proofs();
  const forced = check('ts', 'tsc', { TDD_FORCE: '1' }, cmd);
  assert.equal(forced.status, 0);
  assert.doesNotMatch(forced.output, /proof reused/);
  assert.equal(runs(), 2);
  const after = proofs();
  assert.equal(after.length, 1);
  assert.equal(after[0].E, first.E);
  assert.notEqual(after[0].S, first.S);
  assert.match(check('ts', 'tsc', {}, cmd).output, /proof reused: tsc/);
  assert.equal(runs(), 2);
});

test('proofs: a tool outside proofs runs every time without a proof', needsZpm, () => {
  const { dir, check, runs, proofs } = proofRepo();
  assert.equal(check('threejs', 'capture').status, 0);
  assert.equal(check('threejs', 'capture').status, 0);
  assert.equal(runs(), 2);
  assert.deepEqual(proofs(), []);
  assert.ok(!existsSync(join(dir, '.zpm')), 'the base is not created for a tool outside proofs');
});

test('proofs: a language without a scope runs every time without a proof, suite included', needsZpm, () => {
  const { dir, check, green, runs, count } = proofRepo();
  check('go', 'govet');
  check('go', 'govet');
  assert.equal(runs(), 2);
  assert.equal(green('go', count).status, 0);
  assert.equal(green('go', count).status, 0);
  assert.equal(runs(), 4);
  assert.ok(!existsSync(join(dir, '.zpm')));
});

test('proofs: TDD_DRY_RUN prints the command without calling zpm, even when a proof holds', needsZpm, () => {
  const { check, green, runs, count } = proofRepo();
  check('ts', 'tsc');
  const fake = fakeZpm();
  const dry = check('ts', 'tsc', { TDD_DRY_RUN: '1', ...fake.env }, null);
  assert.match(dry.output, /npm --prefix pwa run typecheck/);
  assert.doesNotMatch(dry.output, /proof reused/);
  assert.match(green('ts', count, { TDD_DRY_RUN: '1', ...fake.env }).stdout, /echo x/);
  assert.deepEqual(fake.calls(), []);
  assert.equal(runs(), 1);
});

test('proofs: an empty command passes without writing a proof, without ticket or lease', needsZpm, () => {
  const { check, proofs } = proofRepo();
  const rt = runtime();
  assert.equal(check('php', 'infection', rt.env(), null).status, 0);
  assert.deepEqual(readdirSync(rt.dir), [], 'no ticket, no slot, no lease');
  assert.equal(check('ts', 'stryker', {}, null).status, 0);
  assert.equal(check('ts', 'stryker', {}, null).status, 0);
  assert.deepEqual(proofs(), []);
});

test('proofs: a mutation proof does not hold for another list of files', needsZpm, () => {
  const { dir, sh, check, runs, proofs } = proofRepo();
  writeFileSync(join(dir, 'api', 'src', 'Game', 'A.php'), '<?php\n');
  sh('git checkout -q -b change && git add -A && git -c user.email=a@b -c user.name=t commit -qm "slice 1"');
  const slice1 = sh('git rev-parse HEAD').stdout.trim();
  writeFileSync(join(dir, 'api', 'src', 'Game', 'B.php'), '<?php\n');

  assert.equal(check('php', 'infection', { TDD_BASE: slice1 }).status, 0);
  const final = check('php', 'infection');
  assert.doesNotMatch(final.output, /proof reused/);
  assert.equal(runs(), 2);
  const written = proofs();
  assert.deepEqual(written.map((p) => p.O), ['infection', 'infection']);
  assert.equal(written[0].E, written[1].E);
  assert.notEqual(written[0].P, written[1].P);
  assert.ok(written.every((p) => /^[0-9a-f]{64}$/.test(p.P)));

  assert.match(check('php', 'infection').output, /proof reused: infection/);
  assert.match(check('php', 'infection', { TDD_BASE: slice1 }).output, /proof reused: infection/);
  assert.equal(runs(), 2);
});

test('proofs: the green suite is read again by check php phpunit, which restores the JUnit report', needsZpm, () => {
  const { dir, check, green, runs, proofs, count } = proofRepo();
  const junit = join(dir, 'api', 'reports', 'junit-integration.xml');
  const suite = `${count}; mkdir -p api/reports; echo '<testsuites/>' > api/reports/junit-integration.xml`;
  assert.equal(green('php', suite).status, 0);
  assert.deepEqual(proofs().map(({ O, P }) => ({ O, P })), [{ O: 'suite', P: 'complet' }]);
  rmSync(junit);

  const review = check('php', 'phpunit', {}, suite);
  assert.equal(review.status, 0);
  assert.match(review.output, /^suite reused: fingerprint [0-9a-f]{8}$/m);
  assert.equal(runs(), 1);
  assert.equal(readFileSync(junit, 'utf8'), '<testsuites/>\n');
  assert.equal(proofs().length, 1);
});

test('proofs: an altered kept report runs the tool again and removes the proof', needsZpm, () => {
  const { dir, check, runs, proofs, reports, count } = proofRepo();
  // The same command, so the same fingerprint: it fails as soon as the marker file, outside the scope, exists.
  const cmd = `${count}; test ! -e ${join(dir, 'failure')}`;
  assert.equal(check('ts', 'tsc', {}, cmd).status, 0);
  const [first] = proofs();
  writeFileSync(join(reports, first.S), 'altered\n');
  writeFileSync(join(dir, 'failure'), '');
  const second = check('ts', 'tsc', {}, cmd);
  assert.equal(second.status, 30);
  assert.doesNotMatch(second.output, /proof reused/);
  assert.equal(runs(), 2);
  assert.deepEqual(proofs(), []);
});

// Replacement zpm in the PATH: the exit code stays the one of the tool.
test('proofs: without zpm in the PATH, the tool runs with its code and nothing is written', () => {
  const { dir, check, runs } = proofRepo();
  const env = { PATH: pathWithoutZpm };
  assert.equal(check('ts', 'tsc', env).status, 0);
  assert.equal(check('ts', 'tsc', env).status, 0);
  assert.equal(runs(), 2);
  assert.equal(check('ts', 'tsc', env, 'exit 1').status, 30);
  assert.ok(!existsSync(join(dir, '.zpm')));
  assert.ok(!existsSync(join(dir, '.git', 'awf', 'preuves')));
});

test('proofs: base in degraded mode, the tool runs with its code and no proof is written', () => {
  const { check, runs } = proofRepo();
  const fake = fakeZpm({ status: `printf '%s\\n' '${JSON.stringify(['status: degraded\ndir: /x'])}'` });
  const first = check('ts', 'tsc', fake.env);
  assert.equal(first.status, 0);
  assert.match(first.output, /is not in durable mode/);
  assert.equal(check('ts', 'tsc', fake.env).status, 0);
  assert.equal(runs(), 2);
  assert.equal(check('ts', 'tsc', fake.env, 'exit 1').status, 30);
  assert.ok(!fake.calls().includes('query-logic'));
  assert.ok(!fake.calls().includes('remember-fact'));
});

test('proofs: unreadable zpm answer, the tool runs with its code and no proof is written', () => {
  const { check, runs } = proofRepo();
  for (const query of ['echo "{not json"', `echo '["{}"]'`, `echo '["[{\\"T\\":1,\\"S\\":\\"../x\\"}]"]'`, 'exit 1']) {
    const fake = fakeZpm({ query });
    const r = check('ts', 'tsc', fake.env);
    assert.equal(r.status, 0, query);
    assert.match(r.output, /the zpm answer cannot be read/, query);
    assert.equal(check('ts', 'tsc', fake.env, 'exit 1').status, 30, query);
    assert.ok(!fake.calls().includes('remember-fact'), query);
  }
  assert.equal(runs(), 4);
});

test('proofs: failed write, the code stays the one of the tool', () => {
  const { check, runs } = proofRepo();
  const fake = fakeZpm({ remember: 'exit 1' });
  const r = check('ts', 'tsc', fake.env);
  assert.equal(r.status, 0);
  assert.match(r.output, /the proof of tsc is not written/);
  assert.ok(fake.calls().includes('remember-fact'));
  assert.equal(check('ts', 'tsc', fake.env, 'exit 1').status, 30);
  assert.equal(runs(), 1);
});

// Purge of old proofs (portes-preuves-et-perimetre, D8), in a throwaway repository whose .zpm/ base the trial creates.
function purgeRepo() {
  const { dir, sh, proofs, reports } = proofRepo();
  const hex = (n: number) => String(n).padStart(64, '0');
  const now = Math.floor(Date.now() / 1000);
  const daysAgo = (days: number) => now - days * 86_400;
  sh('zpm init');
  mkdirSync(reports, { recursive: true });
  // Proofs "tool n age-in-days": fact preuve(tool, complet, hex(n), timestamp, hex(n)).
  const remember = (rows: [string, number, number][]) =>
    sh(rows.map(([tool, n, days]) => `zpm remember-fact --fact "preuve(${tool}, complet, '${hex(n)}', ${daysAgo(days)}, '${hex(n)}')" >/dev/null`).join(' && '));
  const reportAt = (n: number, days: number) => {
    writeFileSync(join(reports, hex(n)), 'report\n');
    utimesSync(join(reports, hex(n)), daysAgo(days), daysAgo(days));
  };
  const purge = (extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, 'proofs', 'purge'], { encoding: 'utf8', cwd: dir, env: { ...process.env, ...extra } });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  return { dir, hex, remember, reportAt, purge, proofs, reports };
}

test('purge: a 31-day-old proof goes with its report, a proof from the day before stays', needsZpm, () => {
  const { hex, remember, reportAt, purge, proofs, reports } = purgeRepo();
  remember([['tsc', 1, 31], ['eslint', 2, 1], ['suite', 3, 31], ['suite', 3, 1]]);
  reportAt(1, 31);
  reportAt(2, 1);
  reportAt(3, 1); // same output as a proof from the day before: the report was rewritten yesterday
  reportAt(4, 31); // old report without a proof

  const r = purge();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^Proof purge: 2 proof\(s\) and 2 report\(s\) older than 30 day\(s\) removed\.$/m);
  assert.deepEqual(proofs().map((p) => p.O).sort(), ['eslint', 'suite']);
  assert.ok(!existsSync(join(reports, hex(1))), 'the report of the 31-day-old proof is deleted');
  assert.ok(existsSync(join(reports, hex(2))), 'the report from the day before stays');
  assert.ok(existsSync(join(reports, hex(3))), 'a report that a recent proof shares stays');
  assert.ok(!existsSync(join(reports, hex(4))), 'an old report without a proof is deleted');
});

test('purge: more than 100 old proofs are all removed', needsZpm, () => {
  const { remember, purge, proofs } = purgeRepo();
  remember([...Array.from({ length: 105 }, (_, i): [string, number, number] => ['tsc', i, 40]), ['eslint', 200, 1]]);
  const r = purge();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /105 proof\(s\)/);
  assert.deepEqual(proofs().map((p) => p.O), ['eslint']);
});

test('purge: TDD_PROOF_DAYS sets the delay, and an invalid value is a misuse (code 2)', needsZpm, () => {
  const { remember, purge, proofs } = purgeRepo();
  remember([['tsc', 1, 3], ['eslint', 2, 1]]);
  for (const days of ['abc', '0', '-1', '1.5', '']) {
    const r = purge({ TDD_PROOF_DAYS: days });
    assert.equal(r.status, days === '' ? 0 : 2, `"${days}": ${r.output}`);
    if (days !== '') assert.match(r.output, /Invalid retention delay ".*".*TDD_PROOF_DAYS/, days);
  }
  assert.equal(proofs().length, 2);
  assert.equal(purge({ TDD_PROOF_DAYS: '2' }).status, 0);
  assert.deepEqual(proofs().map((p) => p.O), ['eslint']);
});

test('purge: without zpm in the PATH, code 0 and nothing is created; an unknown subcommand is a misuse', () => {
  const { dir } = proofRepo();
  const run = (sub: string, env: Record<string, string>) => spawnSync('bash', [SCRIPT, 'proofs', sub], { encoding: 'utf8', cwd: dir, env: { ...process.env, ...env } });
  const r = run('purge', { PATH: pathWithoutZpm });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /zpm is not in the PATH/);
  assert.ok(!existsSync(join(dir, '.zpm')));
  assert.equal(run('purge', { PATH: pathWithoutZpm, TDD_PROOF_DAYS: 'x' }).status, 2);
  assert.equal(run('list', {}).status, 2);
});

test('purge: base in degraded mode or unreadable answer, code 1 and nothing removed', () => {
  const { dir } = proofRepo();
  const run = (fake: ReturnType<typeof fakeZpm>) => spawnSync('bash', [SCRIPT, 'proofs', 'purge'], { encoding: 'utf8', cwd: dir, env: { ...process.env, ...fake.env } });
  const degraded = fakeZpm({ status: `printf '%s\\n' '${JSON.stringify(['status: degraded\ndir: /x'])}'` });
  const first = run(degraded);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /is not in durable mode/);
  assert.ok(!degraded.calls().includes('query-logic'));
  const unreadable = fakeZpm({ query: 'echo "{not json"' });
  const second = run(unreadable);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /the zpm answer cannot be read/);
  assert.ok(!unreadable.calls().includes('forget-fact'));
});

test('header: the proof store is described there, the suite record no longer appears', () => {
  const header = readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => line.startsWith('#')).join('\n');
  assert.match(header, /preuve\(<tool>, <scope>, '<fingerprint>'/);
  assert.match(header, /TDD_ZPM_ROOT/);
  assert.match(header, /proof reused: <tool>, fingerprint <8 characters>/);
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /suite-<langage>\.json|suite-\$kind\.json/);
});

// Review resume at the mutation tool (portes-preuves-et-perimetre, D10), in a throwaway repository.
function resumeRepo() {
  const repo = proofRepo();
  const file = join(repo.dir, '.awf', 'status', 'review-resume.json');
  const resumeTool = (language: string) => {
    const r = spawnSync('bash', [SCRIPT, 'resume-tool', language], { encoding: 'utf8', cwd: repo.dir, env: { ...process.env, TDD_STATUS_FILE: join(repo.dir, 'status.json') } });
    return { status: r.status, stdout: r.stdout };
  };
  const fail = (language: string, tool: string) => repo.check(language, tool, {}, 'echo "surviving mutant"; exit 1');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  };
  return { ...repo, file, resumeTool, fail, write };
}
const nothing = { status: 0, stdout: '' };

test('resume: failed mutation testing writes the tool and the fingerprint without tests, and a test added alone resumes at mutation testing', () => {
  const { file, resumeTool, fail, write } = resumeRepo();
  assert.equal(fail('php', 'infection').status, 30);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.tool, 'infection');
  assert.match(written.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(written), ['tool', 'fingerprint']);

  write('api/tests/Game/BaseTest.php', '<?php\n');
  assert.deepEqual(resumeTool('php'), { status: 0, stdout: 'infection\n' });
  assert.deepEqual(resumeTool('api'), { status: 0, stdout: 'infection\n' });
  assert.deepEqual(resumeTool('ts'), nothing);
});

test('resume: stryker fails, then a test added alone resumes at stryker', () => {
  const { resumeTool, fail, write } = resumeRepo();
  assert.equal(fail('ts', 'stryker').status, 30);
  write('pwa/tests/a.unit.test.ts', 'export {};\n');
  assert.deepEqual(resumeTool('ts'), { status: 0, stdout: 'stryker\n' });
  assert.deepEqual(resumeTool('php'), nothing);
});

test('resume: a production file modified with the test starts again from the beginning', () => {
  const { resumeTool, fail, write } = resumeRepo();
  fail('php', 'infection');
  write('api/tests/Game/BaseTest.php', '<?php\n');
  write('api/src/Game/Base.php', '<?php // fixed\n');
  assert.deepEqual(resumeTool('php'), nothing);
});

test('resume: a configuration file of the scope, modified or added, starts again from the beginning', () => {
  const modified = resumeRepo();
  modified.write('api/phpunit.xml', '<phpunit/>\n');
  modified.fail('php', 'infection');
  modified.write('api/phpunit.xml', '<phpunit colors="true"/>\n');
  assert.deepEqual(modified.resumeTool('php'), nothing);

  const added = resumeRepo();
  added.fail('php', 'infection');
  added.write('compose.yaml', 'services: {}\n');
  assert.deepEqual(added.resumeTool('php'), nothing);
});

test('resume: the failure of another tool writes nothing, and the first tool of the review clears the resume', () => {
  const { file, resumeTool, fail, check } = resumeRepo();
  assert.equal(fail('php', 'psalm').status, 30);
  assert.ok(!existsSync(file));
  assert.deepEqual(resumeTool('php'), nothing);

  fail('php', 'infection');
  assert.equal(check('php', 'psalm').status, 0);
  assert.ok(existsSync(file), 'a tool that is not the first one leaves the resume');
  assert.equal(fail('php', 'phpstan').status, 30);
  assert.ok(!existsSync(file));
  assert.deepEqual(resumeTool('php'), nothing);
});

test('resume: passing mutation testing clears the resume', () => {
  const { file, resumeTool, fail, check } = resumeRepo();
  fail('php', 'infection');
  assert.equal(check('php', 'infection').status, 0);
  assert.ok(!existsSync(file));
  assert.deepEqual(resumeTool('php'), nothing);
});

test('resume: a reused mutation proof clears the resume', needsZpm, () => {
  const { file, fail, check, write } = resumeRepo();
  assert.equal(check('php', 'infection').status, 0);
  write('api/src/Game/Base.php', '<?php // regression\n');
  fail('php', 'infection');
  write('api/src/Game/Base.php', '<?php\n');
  assert.match(check('php', 'infection').output, /proof reused: infection/);
  assert.ok(!existsSync(file));
});

test('resume: resume file missing or unreadable, nothing is written and the code is 0', () => {
  const { file, resumeTool, fail } = resumeRepo();
  assert.deepEqual(resumeTool('php'), nothing);

  fail('php', 'infection');
  for (const content of ['', 'not json', '{"tool":"infection"}', '{"fingerprint":"abc"}', '["infection"]']) {
    writeFileSync(file, content);
    assert.deepEqual(resumeTool('php'), nothing, content);
  }
});

test('resume: a language without mutation, without scope or unknown writes nothing, code 0', () => {
  const { file, resumeTool, fail } = resumeRepo();
  assert.equal(fail('threejs', 'capture').status, 30);
  assert.equal(fail('go', 'gotest').status, 30);
  assert.ok(!existsSync(file));
  fail('php', 'infection');
  for (const language of ['threejs', 'go', 'docs', 'unknown', '']) assert.deepEqual(resumeTool(language), nothing, language);
});

test('resume: dry-run mode does not touch the resume file', () => {
  const { file, fail, check } = resumeRepo();
  fail('php', 'infection');
  check('php', 'phpstan', { TDD_DRY_RUN: '1' });
  check('php', 'infection', { TDD_DRY_RUN: '1' });
  assert.ok(existsSync(file));
});

test('header: the review resume is described there', () => {
  const header = readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => line.startsWith('#')).join('\n');
  assert.match(header, /tdd-gate\.sh resume-tool <language>/);
  assert.match(header, /\.awf\/status\/review-resume\.json/);
  assert.match(header, /\{"tool":"infection","fingerprint":"<fingerprint without tests>"\}/);
});

// --- Rust entries and critical slices ---

const RUST_REGISTRY = `rust:
  workflow: tdd-slice-rust
  dir: .
  test: cargo test --all-targets
  tests:
    - '(^|/)(tests|[a-z0-9_]+_tests)\\.rs$'
  checks:
    unit: cargo test --lib
    trace: bash {pack_scripts}/critical-trace.sh {change} rust
    db: bash {scripts}/test-database.sh url {change} x
  review_steps: [unit]
  critical_steps: [trace, harness]
  required: [harness]
  last: unit
`;

function rustRepo(): string {
  const root = mkdtempSync(join(work, 'rust-'));
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf', 'languages.yaml'), RUST_REGISTRY);
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('classify: Rust levels and the harness go back to GREEN, a missed mutant to RED, trace and required stop', () => {
  for (const tool of ['fmt', 'clippy', 'unit', 'functional', 'integration', 'e2e', 'perf', 'harness']) {
    assert.deepEqual(classify(tool, 'x', join(work, `sha-rust-${tool}`)), { status: 0, phase: 'green' }, tool);
  }
  assert.deepEqual(classify('mutants', 'MISSED src/add/mod.rs:3', join(work, 'sha-rust-mutants')), { status: 0, phase: 'red' });
  for (const tool of ['trace', 'required']) assert.deepEqual(classify(tool, 'x', join(work, `sha-rust-${tool}`)), { status: 0, phase: 'stop' }, tool);
});

test('check: a required tool without command fails a critical slice with 30 and the status word `required`', () => {
  const root = rustRepo();
  const statusFile = join(root, 'status.json');
  const run = (env: Record<string, string>) => spawnSync('bash', [SCRIPT, 'check', 'rust', 'harness'], {
    encoding: 'utf8', cwd: root, env: { ...process.env, OPENSPEC_ROOT: root, TDD_STATUS_FILE: statusFile, XDG_RUNTIME_DIR: work, ...env },
  });

  const critical = run({ TDD_CRITICAL: '1' });
  assert.equal(critical.status, 30);
  assert.match(critical.stdout, /harness: no command in `checks`, but a critical slice requires it/);
  assert.deepEqual(JSON.parse(readFileSync(statusFile, 'utf8')), { phase: 'check', hexagon: 'rust', code: 30, message: 'required harness has no command' });
  assert.equal(run({}).status, 2, 'an ordinary slice keeps the unknown-tool error');
});

test('check: a critical slice does not turn a tool outside `required` into a failure of 30', () => {
  const root = rustRepo();
  const result = spawnSync('bash', [SCRIPT, 'check', 'rust', 'clippy'], {
    encoding: 'utf8', cwd: root, env: { ...process.env, OPENSPEC_ROOT: root, TDD_STATUS_FILE: join(root, 'status.json'), TDD_CRITICAL: '1' },
  });

  assert.equal(result.status, 2);
});

test('markers: {scripts} is the project .awf/scripts, {pack_scripts} the pack scripts folder', () => {
  const root = rustRepo();
  const dry = (tool: string) => spawnSync('bash', [SCRIPT, 'check', 'rust', tool], {
    encoding: 'utf8', cwd: root, env: { ...process.env, OPENSPEC_ROOT: root, TDD_DRY_RUN: '1', TDD_CHANGE: 'c1', XDG_RUNTIME_DIR: work },
  }).stdout;

  assert.match(dry('trace'), new RegExp(`bash ${dirname(SCRIPT).replaceAll('/', '\\/')}\\/critical-trace\\.sh c1 rust`));
  assert.match(dry('db'), new RegExp(`bash ${root.replaceAll('/', '\\/')}\\/\\.awf\\/scripts\\/test-database\\.sh url c1 x`));
});

test('red-mutants: a Rust unit test file targets the module of its folder or of its name', () => {
  for (const [file, mutated] of [['src/add/tests.rs', 'src/add/mod.rs'], ['src/add/tests.rs', 'src/add.rs'], ['src/parse_tests.rs', 'src/parse.rs']] as const) {
    const review = join(work, `mutants-rust-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(review, `MISSED   ${mutated}:3:7: replace + with - in add\n`);
    const result = gate('red-mutants', 'rust', { OPENSPEC_ROOT: rustRepo(), TDD_REVIEW_OUTPUT: review, TDD_RED_CMD: report(2, 0) }, [file]);
    assert.equal(result.status, 0, `${file} -> ${mutated}: ${result.output}`);
  }
  const review = join(work, 'mutants-rust-other.txt');
  writeFileSync(review, 'MISSED   src/other.rs:3:7: replace + with -\n');
  assert.equal(gate('red-mutants', 'rust', { OPENSPEC_ROOT: rustRepo(), TDD_REVIEW_OUTPUT: review, TDD_RED_CMD: report(2, 0) }, ['src/add/tests.rs']).status, 13);
});
