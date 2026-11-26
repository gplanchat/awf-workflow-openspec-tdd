// flow-resolve: the request it hands to flow-update, replaced here by a stub that records it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const available = spawnSync('awf', ['--help'], { encoding: 'utf8' }).status === 0;
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'flow-resolve-'));
after(() => rmSync(work, { recursive: true, force: true }));
const GIT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** A stub flow-update that writes its request to request.txt, and fails when the file fail exists. */
const STUB_UPDATE = `name: flow-update
version: "0.0.1"
inputs:
  - name: change
    type: string
    required: true
  - name: agent
    type: string
    default: claude
  - name: request
    type: string
    default: ""
states:
  initial: record
  record:
    type: step
    command: |
      cat > request.txt <<'AWF_REQUEST_END'
      {{.inputs.request}}
      AWF_REQUEST_END
      test ! -e fail
    on_success: done
    on_failure: failed
  done:
    type: terminal
    status: success
  failed:
    type: terminal
    status: failure
`;

const RECORDED = {
  change: 'demo',
  status: 'revise',
  findings: [
    { reviewer: 'zoom-out', severity: 'Blocker', label: 'issue (blocking)', scope: 'proposal.md:1', finding: 'The proposal does not say why.', recommendation: 'Add the motivation.' },
    { reviewer: 'style', severity: 'Nit', label: 'nitpick (non-blocking)', scope: 'tasks.md', finding: 'Terse task.', recommendation: '' },
  ],
};

function project(recorded = true): string {
  const root = mkdtempSync(join(work, 'p-'));
  for (const dir of ['.awf/workflows', '.awf/scripts', 'openspec/changes/demo']) mkdirSync(join(root, dir), { recursive: true });
  cpSync(join(PACK, 'workflows', 'flow-resolve.yaml'), join(root, '.awf/workflows/flow-resolve.yaml'));
  writeFileSync(join(root, '.awf/workflows/flow-update.yaml'), STUB_UPDATE);
  for (const script of ['egm-review.sh', 'flow.sh', 'openspec-tasks.sh', 'openspec-tasks.mts']) cpSync(join(PACK, 'scripts', script), join(root, '.awf/scripts', script));
  writeFileSync(join(root, 'openspec/changes/demo/proposal.md'), '# Demo\n');
  if (recorded) writeFileSync(join(root, 'openspec/changes/demo/egm-review.json'), JSON.stringify(RECORDED));
  writeFileSync(join(root, '.gitignore'), '.awf/\nrequest.txt\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'init'], ['switch', '-q', '-c', 'docs/propose-demo']]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: { ...process.env, ...GIT } }).status, 0);
  }
  return root;
}

function resolve(root: string, ...inputs: string[]) {
  const args = ['run', 'flow-resolve', '--input', 'change=demo', ...inputs.flatMap((input) => ['--input', input]), '--output', 'buffered'];
  const result = spawnSync('awf', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT } });
  const request = join(root, 'request.txt');
  return { status: result.status, output: `${result.stdout}${result.stderr}`, request: existsSync(request) ? readFileSync(request, 'utf8') : null };
}

test('flow-resolve: without fixes, flow-update gets the Blockers of the recorded review as Conventional Comments', { skip: !available }, () => {
  const run = resolve(project());
  assert.equal(run.status, 0, run.output);
  assert.match(run.request ?? '', /Resolve these findings of the EGM review/);
  assert.match(run.request ?? '', /- issue \(blocking\): The proposal does not say why\. Scope: proposal\.md:1, reviewer zoom-out\. Recommendation: Add the motivation\./);
  assert.doesNotMatch(run.request ?? '', /Terse task/, 'a Nit is not resolved by default');
  assert.match(resolve(project(), 'findings=all').request ?? '', /- nitpick \(non-blocking\): Terse task\./);
});

test('flow-resolve: the approved fixes replace the findings and reach flow-update as text, quotes and $( ) included', { skip: !available }, () => {
  const root = project();
  const fixes = 'Say why in "proposal.md"\nKeep `tasks.md` short, it\'s $(touch pwned) fine';
  const run = resolve(root, `fixes=${fixes}`);
  assert.equal(run.status, 0, run.output);
  assert.match(run.request ?? '', /Apply these fixes, approved after the EGM review/);
  assert.ok(run.request?.includes(fixes), run.request ?? '');
  assert.equal(existsSync(join(root, 'pwned')), false);
});

test('flow-resolve fails without a review, on an invalid findings value, and when flow-update fails, saying which', { skip: !available }, () => {
  const none = resolve(project(false));
  assert.equal(none.status, 3);
  assert.match(none.output, /No EGM review, or no finding to resolve/);
  assert.notEqual(resolve(project(), 'findings=some').status, 0);
  const root = project();
  writeFileSync(join(root, 'fail'), '');
  const failed = resolve(root);
  assert.equal(failed.status, 3);
  assert.match(failed.output, /flow-update failed: see \.awf\/status\/flow-update\.json/);
});
