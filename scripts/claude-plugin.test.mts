// The Claude Code plugin of the repository (claude-plugin/): manifests, commands that call workflows of the pack,
// and the hook that guards the waiver registry.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  assert.deepEqual(files.sort(), ['accept', 'apply-many', 'apply', 'archive', 'explore', 'propose', 'sync', 'update', 'waive'].map((n) => `${n}.md`).sort());
  for (const file of files) {
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

test('hooks.json runs the guard on Bash and write tools, from the plugin root', () => {
  const hooks = json(join(PLUGIN, 'hooks', 'hooks.json')) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
  const [entry] = hooks.hooks.PreToolUse;
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
