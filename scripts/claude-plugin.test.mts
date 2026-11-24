// The Claude Code plugin of the repository (claude-plugin/): manifests, commands that call workflows of the pack,
// and the hook that guards the waiver registry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'claude-plugin');
const COMMANDS = join(PLUGIN, 'commands');
const HOOK = join(PLUGIN, 'hooks', 'waivers-guard.py');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('the marketplace lists the plugin, whose source holds a plugin.json of the same name', () => {
  const marketplace = json(join(ROOT, '.claude-plugin', 'marketplace.json')) as { plugins: { name: string; source: string }[] };
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  const manifest = join(ROOT, entry!.source, '.claude-plugin', 'plugin.json');
  assert.ok(existsSync(manifest), manifest);
  assert.equal(json(manifest).name, entry!.name);
  assert.match(String(json(manifest).version), /^\d+\.\d+\.\d+$/);
});

test('each command has a description and runs only workflows of the pack, which its allowed-tools permit', () => {
  const manifest = readFileSync(join(ROOT, 'manifest.yaml'), 'utf8');
  const workflows = new Set([...(manifest.split(/^workflows:\s*$/m)[1] ?? '').matchAll(/^ {2}- ([\w-]+)\s*$/gm)].map((m) => m[1]));
  const files = readdirSync(COMMANDS).filter((name) => name.endsWith('.md'));
  assert.deepEqual(files.sort(), ['accept', 'apply', 'archive', 'brainstorm', 'explore', 'propose', 'resolve', 'review', 'setup', 'sync', 'update', 'waive'].map((n) => `${n}.md`).sort());
  for (const file of files.filter((name) => name !== 'setup.md')) {
    const text = readFileSync(join(COMMANDS, file), 'utf8');
    assert.match(text, /^---\ndescription: \S/m, file);
    const runs = [...text.matchAll(/awf run openspec-tdd\/([\w-]+)/g)].map((m) => m[1]!);
    assert.ok(runs.length > 0, `${file} runs no workflow`);
    for (const workflow of runs) {
      assert.ok(workflows.has(workflow), `${file}: ${workflow} is not a workflow of the pack`);
      assert.match(text, new RegExp(`^allowed-tools: .*Bash\\(awf run openspec-tdd/${workflow}:\\*\\)`, 'm'), `${file}: allowed-tools must permit ${workflow}`);
    }
  }
});

test('hooks.json runs the setup check at session start and the guard on Bash and write tools, from the plugin root', () => {
  const hooks = json(join(PLUGIN, 'hooks', 'hooks.json')) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
  const [entry] = hooks.hooks.PreToolUse;
  assert.match(JSON.stringify(hooks.hooks), /"SessionStart":\[\{"hooks":\[\{"type":"command","command":"bash \\"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/setup\.sh\\" hook"/);
  assert.equal(entry!.matcher, 'Bash|Edit|Write|NotebookEdit');
  assert.match(entry!.hooks[0]!.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/waivers-guard\.py/);
});

const guard = (input: unknown) => spawnSync('python3', [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
const python = spawnSync('python3', ['--version']).error === undefined;

test('the guard blocks writes to the registry, wherever it lives', { skip: !python }, () => {
  for (const path of ['/repo/.git/awf/waivers.yaml', '/repo/.git/awf/waivers.log', '/repo/.awf/waivers.yaml']) {
    const run = guard({ tool_name: 'Write', tool_input: { file_path: path, content: 'x' } });
    assert.equal(run.status, 2, path);
    assert.match(run.stderr, /\/flow:waive/);
  }
  assert.equal(guard({ tool_name: 'Edit', tool_input: { file_path: '/repo/README.md' } }).status, 0);
});

test('the guard lets flow.sh and plain reads cite the registry, and blocks any other command that does', { skip: !python }, () => {
  const bash = (command: string) => guard({ tool_name: 'Bash', tool_input: { command } }).status;
  assert.equal(bash('bash .awf/workflow-packs/openspec-tdd/scripts/flow.sh waive c scope --reason "x" # waivers.yaml'), 0);
  assert.equal(bash('cat .git/awf/waivers.yaml'), 0);
  assert.equal(bash('awf run openspec-tdd/flow-waive --input change=c --input gate=scope --input reason=x'), 0);
  assert.equal(bash('echo "- {change: c}" >> .git/awf/waivers.yaml'), 2);
  assert.equal(bash('cat .git/awf/waivers.yaml > /tmp/copy; rm .git/awf/waivers.log'), 2);
});

test('the guard decides nothing on unreadable input', { skip: !python }, () => {
  assert.equal(guard('not json').status, 0);
});

const SETUP = join(PLUGIN, 'scripts', 'setup.sh');
const setupText = readFileSync(SETUP, 'utf8');
const pinned = (name: string) => setupText.match(new RegExp(`^${name}=(\\S+)`, 'm'))?.[1];

test('setup.sh pins the pack version of manifest.yaml, its awf floor and the zpm version of tdd-gate.sh', () => {
  const manifest = readFileSync(join(ROOT, 'manifest.yaml'), 'utf8');
  assert.equal(pinned('PACK_VERSION'), manifest.match(/^version: "([^"]+)"/m)?.[1]);
  assert.equal(pinned('AWF_VERSION'), manifest.match(/^awf_version: ">=([^"]+)"/m)?.[1]);
  assert.match(readFileSync(join(ROOT, 'scripts', 'tdd-gate.sh'), 'utf8'), new RegExp(`zpm is version ${pinned('ZPM_VERSION')!.replaceAll('.', '\\.')}`));
});

type Fake = { awf?: string; pack?: string; zpm?: string; awfDir?: boolean; openspec?: boolean; proofs?: string; egm?: boolean };

/** Runs setup.sh in a fresh repository whose PATH holds fake awf and zpm commands reporting the given versions. */
function setup(mode: string, fake: Fake) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-setup-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (fake.awf) {
    writeFileSync(join(bin, 'awf'), `#!/bin/sh\ncase "$1" in --version) echo "awf version ${fake.awf}";; workflow) echo "NAME VERSION"; ${fake.pack ? `echo "openspec-tdd  ${fake.pack}  yes  x"` : ':'};; esac\n`, { mode: 0o755 });
  }
  if (fake.zpm) writeFileSync(join(bin, 'zpm'), `#!/bin/sh\n# zpm writes its version on stderr.\necho "zpm ${fake.zpm}" >&2\n`, { mode: 0o755 });
  spawnSync('git', ['init', '-q', dir]);
  if (fake.awfDir ?? true) mkdirSync(join(dir, '.awf'));
  if (fake.proofs !== undefined) writeFileSync(join(dir, '.awf', 'languages.yaml'), `php:\n  proofs: ${fake.proofs}\n`);
  if (fake.openspec ?? true) mkdirSync(join(dir, 'openspec'));
  if (fake.egm ?? true) mkdirSync(join(dir, '.claude', 'plugins', 'cache', 'egm', 'egm', '0.1.0', 'agents'), { recursive: true });
  const run = spawnSync('bash', [SETUP, mode], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } });
  rmSync(dir, { recursive: true, force: true });
  return run;
}

const ready: Fake = { awf: pinned('AWF_VERSION'), pack: pinned('PACK_VERSION') };

test('setup.sh check passes in silence when awf and the pack are current, with no proofs zpm is not needed, and a current zpm passes', () => {
  for (const fake of [ready, { ...ready, proofs: '[]' }, { ...ready, proofs: '[phpunit]', zpm: pinned('ZPM_VERSION') },{ ...ready, awf: '99.0.0', pack: '99.0.0' }]) {
    const run = setup('check', fake);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout, '');
  }
});

test('setup.sh check lists each missing item with the command that fixes it', () => {
  const cases: [Fake, RegExp][] = [
    [{}, /awf is not installed\. Fix: bash \S+\/scripts\/setup\.sh install awf$/m],
    [{ ...ready, awf: '0.11.8' }, /awf 0\.11\.8 is older than .* Fix: awf upgrade$/m],
    [{ ...ready, awfDir: false }, /no \.awf\/ folder.* Fix: awf init$/m],
    [{ awf: ready.awf }, /pack is not installed\. Fix: awf workflow install gplanchat\/awf-workflow-openspec-tdd@\S+$/m],
    [{ ...ready, pack: '0.1.1' }, /pack is 0\.1\.1, .* Fix: awf workflow install \S+ --force$/m],
    [{ ...ready, proofs: '[phpunit, infection]' }, /zpm is not installed.* Fix: bash \S+ install zpm$/m],
    [{ ...ready, proofs: '[phpunit]', zpm: '0.4.3' }, /zpm 0\.4\.3 is older .* Fix: zpm upgrade$/m],
    [{ ...ready, egm: false }, /EGM plugin is not installed.* Fix: claude plugin marketplace add google\/elephant-goldfish-model && claude plugin install egm@egm$/m],
  ];
  for (const [fake, line] of cases) {
    const run = setup('check', fake);
    assert.equal(run.status, 1, JSON.stringify(fake));
    assert.match(run.stdout, line);
  }
});

test('setup.sh hook prints nothing outside an OpenSpec project or when nothing is missing, and JSON otherwise', () => {
  assert.equal(setup('hook', { openspec: false }).stdout, '');
  assert.equal(setup('hook', ready).stdout, '');
  const run = setup('hook', { ...ready, pack: undefined });
  assert.equal(run.status, 0);
  const out = JSON.parse(run.stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.match(out.systemMessage, /\/flow:setup/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /pack is not installed\. Fix: awf workflow install/);
});

test('setup.sh report starts with the command that runs it again and always exits with code 0', () => {
  for (const [fake, last] of [[ready, /Nothing is missing\.\n$/], [{}, /awf is not installed/]] as [Fake, RegExp][]) {
    const run = setup('report', fake);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^Check again with: bash \S+\/scripts\/setup\.sh report\n/);
    assert.match(run.stdout, last);
  }
});
