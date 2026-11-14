// Since awf 0.11.3 (awf commit 6915876, issue #388), a failed step evaluates its `transitions:` before `on_failure`.
// A transitions list whose only entry is an unconditional `goto` therefore jumps even when the step fails.
// Use `on_success:` for that case.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

test('no transitions list holds a single unconditional goto', () => {
  const offenders = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => [...readFileSync(join(WORKFLOWS, f), 'utf8').matchAll(/^( +)transitions:\n\1  - goto: (\S+)\n(?!\1  - )/gm)]
      .map((m) => `${f}: goto ${m[2]}`));
  assert.deepEqual(offenders, []);
});

// `{{.awf.scripts_dir}}/<name>` resolves to the pack's scripts only when a space or the end of the line follows the
// name; `x.sh;`, `x.sh"` or `x.sh)` resolves to awf's global scripts directory instead.
test('every {{.awf.scripts_dir}}/<name> is followed by a space or the end of the line', () => {
  const offenders = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => readFileSync(join(WORKFLOWS, f), 'utf8').split('\n')
      .flatMap((line, i) => [...line.matchAll(/scripts_dir\}\}\/[\w.-]+(?=[^\s\w.-])/g)].map((m) => `${f}:${i + 1}: ${m[0]}`)));
  assert.deepEqual(offenders, []);
});
