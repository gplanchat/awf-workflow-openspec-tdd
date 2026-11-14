import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Language, aliasTargets, InvalidKeyword, keywordEntries, commitMessage, commitSlice, UnknownSlice, legacyWarning, assertKnownLanguages, parseLanguages, UnknownLanguage, baseline, batches, checkCriterion, checkSlice, checkTask, nextSlice, classify, criteria, CriterionNotOpen, dodFingerprint, SliceWithoutLanguage, SliceWithTwoLanguages, slices, TaskWithoutSlices, InvalidMaxTasks, isParallelGroup, longRequirements, newlyChecked, openTasks, TaskNotOpen, undeclaredManual } from './openspec-tasks.mts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(SCRIPTS, 'openspec-tasks.sh');
const PROJECT = join(SCRIPTS, 'fixtures', 'project'); // test project: its .awf/languages.yaml is the registry under test
process.env.OPENSPEC_ROOT = PROJECT; // its keywords also drive classify() and openTasks()
const work = mkdtempSync(join(tmpdir(), 'openspec-tasks-'));
after(() => rmSync(work, { recursive: true, force: true }));

const SAMPLE = `Chaque tâche suit RED, GREEN, REVIEW.

## 1. Socle de l'API

- [x] 1.1 \`Money\` et \`Instant\` dans le domaine
- [ ] 1.2 Dépôt \`OrderRepository\` : \`get\`, \`save\`, adaptateurs DBAL
- [ ] 1.10 Suite de contrat
- [ ] 1.3 REVIEW du socle : \`composer review\`

## 2. PWA

- [ ] 2.1 Adaptateur HTTP et port \`OrderApi\`
- [ ] 2.2 README : rôles et invitations

## 3. Conformité

- [ ] 3.1 Vérification de bout en bout contre la stack
`;

function project(name: string, content: string): string {
  const root = mkdtempSync(join(work, 'p-'));
  mkdirSync(join(root, 'openspec', 'changes', name), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', name, 'tasks.md'), content);
  mkdirSync(join(root, '.awf'), { recursive: true });
  writeFileSync(join(root, '.awf', 'languages.yaml'), readFileSync(join(PROJECT, '.awf', 'languages.yaml'), 'utf8'));
  return root;
}

function cli(root: string, ...args: string[]) {
  const result = spawnSync('bash', [LAUNCHER, ...args], { encoding: 'utf8', env: { ...process.env, OPENSPEC_ROOT: root } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test('list: only the open tasks, in file order, with their group', () => {
  const tasks = openTasks(SAMPLE);

  assert.deepEqual(tasks.map((t) => t.id), ['1.2', '1.10', '1.3', '2.1', '2.2', '3.1']);
  assert.equal(tasks[0]?.group, '1. Socle de l\'API');
  assert.equal(tasks[3]?.group, '2. PWA');
  assert.equal(tasks[3]?.text, 'Adaptateur HTTP et port `OrderApi`');
});

const CASES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  // text, group, kind, hexagon, rule
  ['REVIEW de `pwa/` aux seuils', '5. PWA', 'review', 'ts', 'review'],
  ['REVIEW de l\'API : `composer review`', '1. Socle', 'review', 'php', 'review'],
  ['[outillage] REVIEW finale : D1 à D4', '6. Fusion', 'review', '', 'review'],
  ['[outillage] Ajouter un test : une REVIEW dont tous les outils sont réutilisés', '2. Preuves', 'manual', 'stack', 'outillage'],
  ['README : décrire la phase REVIEW', '5. Conformité', 'manual', 'docs', 'keywords:docs'],
  ['README : rôles et invitations', '5. Conformité', 'manual', 'docs', 'keywords:docs'],
  ['Vérification de bout en bout contre la stack', '6. Essai', 'manual', 'e2e', 'keywords:e2e'],
  ['Dans un navigateur : deux sessions simultanées', '5. X', 'manual', 'e2e', 'keywords:e2e'],
  ['Adaptateur HTTP et port `OrderApi`', '4. PWA', 'slice', 'ts', 'group:ts'],
  ['Adaptateur HTTP et port `OrderApi`', '4. Lectures', 'slice', 'php', 'group:php'],
  ['Adaptateurs DBAL de `api/src/Game`', '4. PWA', 'slice', 'php', 'strong:php'],
  ['Composants : montants affichés', '5. Rendu', 'slice', 'ts', 'group:ts'],
  ['`<order-home>` : liste des parties', '3. X', 'slice', 'ts', 'keywords:ts'],
  ['Realm : client confidentiel, secrets, README', '1. Stack', 'manual', 'stack', 'keywords:stack'],
  ['Service `keycloak` du compose', '2. Stack', 'manual', 'stack', 'keywords:stack'],
  ['Déplacer les ressources', '1. Couche UserInterface', 'slice', 'php', 'group:php'],
  ['Murs de quai, margelle', '2. Rendu', 'slice', 'ts', 'group:ts'],
  ['La PWA appelle l\'API', '3. X', 'manual', 'docs', 'tie'],
  ['[outillage] Écrire un workflow PHP qui lève une exception', '1. X', 'manual', 'stack', 'outillage'],
  ['[stack] Image avec install-php-extensions, PostgreSQL et composer dans api/', '1. Image', 'manual', 'stack', 'stack-tag'],
  ['[docs] Page de référence de la commande `bin/stack`', '2. Docs', 'manual', 'docs', 'docs-tag'],
  ['Sans indice', '3. Divers', 'manual', 'docs', 'default'],
  // English forms of the French markers above
  ['[tooling] Add a test: a REVIEW whose tools are all reused', '2. Proofs', 'manual', 'stack', 'outillage'],
  ['Move the component tests (verified by D9) [tooling]', '2. Play', 'manual', 'stack', 'outillage'],
  ['End-to-end check against the stack', '6. Trial', 'manual', 'e2e', 'keywords:e2e'],
  ['In a browser: two simultaneous sessions', '5. X', 'manual', 'e2e', 'keywords:e2e'],
  ['Live test of the sign-up flow', '5. X', 'manual', 'e2e', 'keywords:e2e'],
  ['Repository and adapters of the orders', '3. X', 'slice', 'php', 'keywords:php'],
  ['Use case, aggregate and event of the order', '3. X', 'slice', 'php', 'keywords:php'],
  ['Components: displayed amounts', '5. X', 'slice', 'ts', 'keywords:ts'],
  ['Quay walls, coping', '2. Rendering', 'slice', 'ts', 'group:ts'],
  ['Move the resources', '1. Domain layer', 'slice', 'php', 'group:php'],
  ['`OrderRepository` reads', '3. X', 'manual', 'docs', 'default'],
];

for (const [text, group, kind, hexagon, rule] of CASES) {
  test(`classify: "${text}" under "${group}" -> ${kind} ${hexagon} (${rule})`, () => {
    assert.deepEqual(classify(text, group), { kind, hexagon, rule });
  });
}

test('check: checks exactly the line of the task', () => {
  const after = checkTask(SAMPLE, '1.2');
  const before = SAMPLE.split('\n');
  const changed = after.split('\n').flatMap((line, index) => (line === before[index] ? [] : [[before[index], line]]));

  assert.deepEqual(changed, [['- [ ] 1.2 Dépôt `OrderRepository` : `get`, `save`, adaptateurs DBAL', '- [x] 1.2 Dépôt `OrderRepository` : `get`, `save`, adaptateurs DBAL']]);
});

test('check: 1.1 does not check 1.10 and the other way round', () => {
  assert.match(checkTask(SAMPLE, '1.10'), /- \[x\] 1\.10 Suite de contrat/);
  assert.throws(() => checkTask(SAMPLE, '1.1'), TaskNotOpen);
});

test('check: an already checked or unknown task throws TaskNotOpen with its context', () => {
  for (const id of ['1.1', '9.9']) {
    assert.throws(() => checkTask(SAMPLE, id, 'mon-change'), (error: unknown) => {
      assert.ok(error instanceof TaskNotOpen);
      assert.equal(error.id, id);
      assert.equal(error.change, 'mon-change');
      assert.doesNotMatch(error.message, new RegExp(id.replace('.', '\\.')));
      return true;
    });
  }
});

test('CLI list: a JSON array', () => {
  const root = project('demo', SAMPLE);
  const { status, out } = cli(root, 'list', 'demo');

  assert.equal(status, 0);
  const tasks = JSON.parse(out) as Array<{ id: string; kind: string; hexagon: string }>;
  assert.equal(tasks.length, 6);
  assert.deepEqual(tasks.find((t) => t.id === '1.3'), { id: '1.3', text: 'REVIEW du socle : `composer review`', group: '1. Socle de l\'API', kind: 'review', hexagon: 'php', rule: 'review', parallel: false });
});

test('CLI check: writes tasks.md', () => {
  const root = project('demo', SAMPLE);
  const { status, out } = cli(root, 'check', 'demo', '2.1');

  assert.equal(status, 0);
  assert.match(out, /Task 2\.1 checked/);
  assert.match(readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[x\] 2\.1 Adaptateur HTTP/);
});

test('CLI check: an already checked task changes nothing and succeeds', () => {
  const root = project('demo', SAMPLE);
  const tasksFile = join(root, 'openspec', 'changes', 'demo', 'tasks.md');
  const before = readFileSync(tasksFile, 'utf8');

  const { status, out } = cli(root, 'check', 'demo', '1.1');

  assert.equal(status, 0);
  assert.match(out, /Task 1\.1 already checked/);
  assert.equal(readFileSync(tasksFile, 'utf8'), before);
});

test('CLI: unknown change (code 1), task not open (code 1), wrong usage (code 2)', () => {
  const root = project('demo', SAMPLE);

  const unknown = cli(root, 'list', 'absent');
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /cannot be found or read/);
  assert.match(unknown.err, /Change: absent/);

  const missing = cli(root, 'check', 'demo', '9.9');
  assert.equal(missing.status, 1);
  assert.match(missing.err, /already checked/);

  assert.equal(cli(root, 'check', 'demo').status, 2);
  assert.equal(cli(root).status, 2);
});

test('CLI ids and get', () => {
  const root = project('demo', SAMPLE);

  assert.deepEqual(JSON.parse(cli(root, 'ids', 'demo').out), ['1.2', '1.10', '1.3', '2.1', '2.2', '3.1']);
  assert.equal(cli(root, 'get', 'demo', '2.1', 'hexagon').out, 'ts');
  assert.equal(cli(root, 'get', 'demo', '2.2', 'text').out, 'README : rôles et invitations');
  assert.equal(cli(root, 'get', 'demo', '2.1', 'couleur').status, 1);
  assert.match(cli(root, 'get', 'demo', '9.9', 'kind').err, /already checked/);
});

test('CLI close-reviews: checks the REVIEW tasks and no other task', () => {
  const root = project('demo', SAMPLE);
  const { out } = cli(root, 'close-reviews', 'demo');
  const content = readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8');

  assert.match(out, /1\.3/);
  assert.match(content, /- \[x\] 1\.3 REVIEW/);
  assert.match(content, /- \[ \] 1\.2 /);
});

test('report: done tasks, failed task and phase of the last gate', () => {
  const root = project('demo', SAMPLE);
  const dir = join(root, '.awf', 'status');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'apply-change.done'), '1.2\n1.10\n');
  writeFileSync(join(dir, 'apply-change.current'), '1.3\n');
  writeFileSync(join(dir, 'tdd-slice.json'), '{"phase":"review","hexagon":"api","code":30,"message":"revue en échec"}\n');

  assert.deepEqual(JSON.parse(cli(root, 'report', 'demo', 'failed').out), {
    change: 'demo',
    done: ['1.2', '1.10'],
    failed: { id: '1.3', phase: 'review', status: 30 },
    status: 'failed',
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'apply-change.json'), 'utf8')).status, 'failed');
  assert.deepEqual(JSON.parse(cli(root, 'report', 'demo', 'done').out), { change: 'demo', done: ['1.2', '1.10'], failed: null, status: 'done' });
});

test('isParallelGroup: the French marker ends the title, case and accents ignored', () => {
  for (const title of ['2. Rendu (parallèle)', '2. Rendu (Parallèle)', '2. Rendu (parallele)', '2. Rendu ( PARALLÈLE ) ']) assert.equal(isParallelGroup(title), true, title);
  for (const title of ['2. Rendu', '2. Rendu parallèle', '2. (parallèle) Rendu', '2. Rendu (parallèles)', '']) assert.equal(isParallelGroup(title), false, title);
});

test('isParallelGroup: the English marker "(parallel)" ends the title, case ignored', () => {
  for (const title of ['2. Render (parallel)', '2. Render (Parallel)', '2. Render ( PARALLEL ) ']) assert.equal(isParallelGroup(title), true, title);
  for (const title of ['2. Render parallel', '2. (parallel) Render', '2. Render (parallels)']) assert.equal(isParallelGroup(title), false, title);
});

test('list: parallel is true only for the tasks of a marked group', () => {
  const tasks = openTasks('## 1. Socle\n\n- [ ] 1.1 A\n\n## 2. Rendu (parallèle)\n\n- [ ] 2.1 B\n');

  assert.deepEqual(tasks.map((t) => [t.id, t.parallel]), [['1.1', false], ['2.1', true]]);
});

const GROUPS = `## 1. Socle de l'API

- [ ] 1.1 Dépôt \`A\` en DBAL
- [ ] 1.2 Dépôt \`B\` en DBAL

## 2. Rendu (parallèle)

- [ ] 2.1 Composant \`pwa/\` A
- [x] 2.2 Composant \`pwa/\` B
- [ ] 2.3 Composant \`pwa/\` C
- [ ] 2.4 REVIEW de \`pwa/\`
- [ ] 2.5 Composant \`pwa/\` D

## 3. Conformité

- [ ] 3.1 README : parcours
`;

test('batches: max_tasks 1, everything is sequential, marked group included', () => {
  assert.deepEqual(batches(openTasks(GROUPS), 1), ['seq:1.1', 'seq:1.2', 'seq:2.1', 'seq:2.3', 'seq:2.4', 'seq:2.5', 'seq:3.1']);
});

test('batches: max_tasks 2, the open tasks of a marked group form a parallel batch, the REVIEW stays in place', () => {
  assert.deepEqual(batches(openTasks(GROUPS), 2), ['seq:1.1', 'seq:1.2', 'par:2.1 2.3 2.5', 'seq:2.4', 'seq:3.1']);
});

test('batches: a group without a marker stays sequential whatever max_tasks', () => {
  assert.deepEqual(batches(openTasks(GROUPS.replace(' (parallèle)', '')), 5), ['seq:1.1', 'seq:1.2', 'seq:2.1', 'seq:2.3', 'seq:2.4', 'seq:2.5', 'seq:3.1']);
});

test('batches: an English "(parallel)" group forms a parallel batch', () => {
  assert.deepEqual(batches(openTasks(GROUPS.replace(' (parallèle)', ' (parallel)')), 2), ['seq:1.1', 'seq:1.2', 'par:2.1 2.3 2.5', 'seq:2.4', 'seq:3.1']);
});

test('batches: a single open task in a marked group is not a parallel batch (resume)', () => {
  const content = '## 1. Rendu (parallèle)\n\n- [x] 1.1 A\n- [ ] 1.2 Composant \`pwa/\` B\n- [x] 1.3 C\n';

  assert.deepEqual(batches(openTasks(content), 3), ['seq:1.2']);
});

test('batches: invalid max_tasks', () => {
  for (const value of [0, -1, 1.5, Number.NaN]) assert.throws(() => batches(openTasks(GROUPS), value), InvalidMaxTasks);
});

test('CLI batches: --max-tasks, sequential otherwise, an invalid value fails', () => {
  const root = project('demo', GROUPS);

  assert.deepEqual(JSON.parse(cli(root, 'batches', 'demo').out), ['seq:1.1', 'seq:1.2', 'seq:2.1', 'seq:2.3', 'seq:2.4', 'seq:2.5', 'seq:3.1']);
  assert.deepEqual(JSON.parse(cli(root, 'batches', 'demo', '--max-tasks', '2').out), ['seq:1.1', 'seq:1.2', 'par:2.1 2.3 2.5', 'seq:2.4', 'seq:3.1']);
  for (const value of ['0', 'beaucoup']) {
    const run = cli(root, 'batches', 'demo', '--max-tasks', value);
    assert.equal(run.status, 1, value);
    assert.match(run.err, /integer greater than or equal to 1/, value);
  }
  assert.equal(cli(root, 'batches', 'demo', '--max-tasks').status, 1);
});

test('CLI get parallel: true or false as text', () => {
  const root = project('demo', GROUPS);

  assert.equal(cli(root, 'get', 'demo', '2.1', 'parallel').out, 'true');
  assert.equal(cli(root, 'get', 'demo', '1.1', 'parallel').out, 'false');
});

test('task-report: done, skipped, and failed with the phase of the last gate', () => {
  const root = project('demo', SAMPLE);
  const dir = join(root, '.awf', 'status');
  mkdirSync(dir, { recursive: true });

  assert.deepEqual(JSON.parse(cli(root, 'task-report', 'demo', '1.2', 'done').out), { change: 'demo', task: '1.2', status: 'done', failed: null });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'apply-task.json'), 'utf8')).status, 'done');
  assert.equal(JSON.parse(cli(root, 'task-report', 'demo', '1.3', 'skipped').out).status, 'skipped');

  writeFileSync(join(dir, 'tdd-slice.json'), '{"phase":"green","hexagon":"api","code":20,"message":"test en échec"}\n');
  assert.deepEqual(JSON.parse(cli(root, 'task-report', 'demo', '1.2', 'failed').out), { change: 'demo', task: '1.2', status: 'failed', failed: { phase: 'green', status: 20 } });
  assert.equal(cli(root, 'task-report', 'demo', '1.2', 'peut-etre').status, 2);
});

test('record-run-tasks: the merged tasks join the done tasks, the first failed one becomes the current task', () => {
  const root = project('demo', SAMPLE);
  const dir = join(root, '.awf', 'status');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'apply-change.done'), '1.1\n');
  writeFileSync(join(dir, 'run-tasks.json'), JSON.stringify({ tasks: { '2.1': { status: 'done', merged: true }, '2.2': { status: 'failed', merged: false }, '2.3': { status: 'done', merged: false, conflict_files: ['README.md'] } }, status: 'failed' }));

  assert.match(cli(root, 'record-run-tasks', 'demo').out, /merged: 2\.1\./);
  assert.equal(readFileSync(join(dir, 'apply-change.done'), 'utf8'), '1.1\n2.1\n');
  assert.equal(readFileSync(join(dir, 'apply-change.current'), 'utf8'), '2.2\n');
  assert.deepEqual(JSON.parse(cli(root, 'report', 'demo', 'failed').out).failed, { id: '2.2', phase: 'parallel', status: null });
});

test('record-run-tasks: everything is merged, nothing failed', () => {
  const root = project('demo', SAMPLE);
  const dir = join(root, '.awf', 'status');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run-tasks.json'), JSON.stringify({ tasks: { '2.1': { status: 'done', merged: true }, '2.3': { status: 'done', merged: true } }, status: 'done' }));

  cli(root, 'record-run-tasks', 'demo');

  assert.equal(readFileSync(join(dir, 'apply-change.done'), 'utf8'), '2.1\n2.3\n');
  assert.equal(existsSync(join(dir, 'apply-change.current')), false);
  assert.equal(cli(root, 'record-run-tasks', 'inconnu').status, 0);
});

const WITH_DOD = `Chaque tâche suit RED, GREEN, REVIEW.

## Definition of Done

- [ ] D1 Le fichier existe. Vérifié par : \`test -f marque.txt\`
- [ ] D2 La relecture est faite
- [x] D3 Déjà coché. Vérifié par : \`false\`
- [ ] D4 Échoue. Vérifié par : \`echo sortie-brute; exit 3\`

## 1. Socle de l'API

- [ ] 1.1 \`Money\` dans le domaine
`;

test('criteria: id, text, command and state; no section, no criterion', () => {
  assert.deepEqual(criteria(WITH_DOD).map(({ id, text, command, done }) => ({ id, text, command, done })), [
    { id: 'D1', text: 'Le fichier existe.', command: 'test -f marque.txt', done: false },
    { id: 'D2', text: 'La relecture est faite', command: null, done: false },
    { id: 'D3', text: 'Déjà coché.', command: 'false', done: true },
    { id: 'D4', text: 'Échoue.', command: 'echo sortie-brute; exit 3', done: false },
  ]);
  assert.deepEqual(criteria(SAMPLE), []);
});

test('criteria: D boxes outside the section are not criteria, and criteria are not tasks', () => {
  assert.deepEqual(criteria(`## 1. Socle\n\n- [ ] D9 Hors section\n`), []);
  assert.deepEqual(openTasks(WITH_DOD).map((task) => task.id), ['1.1']);
});

test('criteria: "Verified by:" is read like its French alias "Vérifié par :"', () => {
  const english = '## Definition of Done\n\n- [ ] D1 The file exists. Verified by: `test -f mark.txt`\n- [ ] D2 Review done. Manual\n';

  assert.deepEqual(criteria(english).map(({ id, text, command }) => ({ id, text, command })), [
    { id: 'D1', text: 'The file exists.', command: 'test -f mark.txt' },
    { id: 'D2', text: 'Review done. Manual', command: null },
  ]);
});

test('checkCriterion: checks the line of the criterion and no other', () => {
  const checked = checkCriterion(WITH_DOD, 'D2');
  assert.match(checked, /- \[x\] D2 La relecture/);
  assert.match(checked, /- \[ \] D1 /);
  assert.throws(() => checkCriterion(WITH_DOD, 'D3'), CriterionNotOpen);
});

test('CLI dod and check-dod', () => {
  const root = project('demo', WITH_DOD);
  assert.equal(JSON.parse(cli(root, 'dod', 'demo').out).length, 4);
  assert.match(cli(root, 'check-dod', 'demo', 'D2').out, /D2 checked/);
  assert.match(readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[x\] D2 /);
  assert.equal(cli(root, 'check-dod', 'demo', 'D3').status, 1);
});

test('verify-dod: checks the criteria that pass, stops at the first failure (30) with its raw output', () => {
  const root = project('demo', WITH_DOD);
  writeFileSync(join(root, 'marque.txt'), '');
  const result = cli(root, 'verify-dod', 'demo');
  const tasks = readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8');

  assert.equal(result.status, 30);
  assert.match(tasks, /- \[x\] D1 /);
  assert.match(tasks, /- \[ \] D4 /);
  assert.match(result.err + result.out, /D4/);
  assert.match(readFileSync(join(root, '.awf', 'status', 'review-last.txt'), 'utf8'), /sortie-brute/);
});

test('verify-dod: a criterion without a command stays open and is reported; without a section, nothing to do', () => {
  const root = project('demo', '## Definition of Done\n\n- [ ] D1 À la main\n');
  const result = cli(root, 'verify-dod', 'demo');
  assert.equal(result.status, 0);
  assert.match(result.out, /to check by hand: D1/);
  assert.equal(cli(project('vide', SAMPLE), 'verify-dod', 'vide').status, 0);
});

const delta = (section: string, title: string, text: string): string =>
  `## ${section} Requirements\n\n### Requirement: ${title}\n\n${text}\n\n#### Scenario: x\n\n- **WHEN** a\n- **THEN** b\n`;

test('longRequirements: an ADDED or MODIFIED requirement longer than 500 characters is reported with its title, 500 passes', () => {
  assert.deepEqual(longRequirements(delta('ADDED', 'Longue', 'x'.repeat(501))), [{ title: 'Longue', length: 501 }]);
  assert.deepEqual(longRequirements(delta('MODIFIED', 'Modifiée', 'x'.repeat(900))), [{ title: 'Modifiée', length: 900 }]);
  assert.deepEqual(longRequirements(delta('ADDED', 'Limite', 'x'.repeat(500))), []);
});

test('longRequirements: the text stops at the first scenario, REMOVED and RENAMED are ignored', () => {
  const longScenario = `## ADDED Requirements\n\n### Requirement: Courte\n\nLe système SHALL faire.\n\n#### Scenario: long\n\n- **WHEN** ${'x'.repeat(800)}\n- **THEN** b\n`;

  assert.deepEqual(longRequirements(longScenario), []);
  assert.deepEqual(longRequirements(delta('REMOVED', 'Retirée', 'x'.repeat(900))), []);
  assert.deepEqual(longRequirements(delta('RENAMED', 'Renommée', 'x'.repeat(900))), []);
});

test('check-deltas: fails on a too long delta naming the spec and the requirement, passes a change without delta', () => {
  const root = project('demo', SAMPLE);
  mkdirSync(join(root, 'openspec', 'changes', 'demo', 'specs', 'ma-spec'), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', 'demo', 'specs', 'ma-spec', 'spec.md'), delta('MODIFIED', 'Trop longue', 'x'.repeat(600)));
  const refused = cli(root, 'check-deltas', 'demo');

  assert.equal(refused.status, 1);
  assert.match(refused.err, /ma-spec/);
  assert.match(refused.err, /Trop longue/);
  assert.equal(cli(project('sans-delta', SAMPLE), 'check-deltas', 'sans-delta').status, 0);
});

const CONFIG = `rules:
  tasks:
    - "Socle de la Definition of Done, recopié dans chaque change : D1 la REVIEW passe (\`bash .awf/scripts/tdd-gate.sh review api\` pour api/, \`bash .awf/scripts/tdd-gate.sh review pwa\` pour pwa/ ; la mutation ne porte que sur le code ; la revue est celle de la CI) ; D2 le README décrit le change ; D3 les specs sont synchronisées (\`openspec validate <change> --strict\`)."
`;

test('baseline: the baseline criteria with their commands, <change> replaced (French title)', () => {
  assert.deepEqual(baseline(CONFIG, 'demo'), [
    { id: 'D1', commands: ['bash .awf/scripts/tdd-gate.sh review api', 'bash .awf/scripts/tdd-gate.sh review pwa'] },
    { id: 'D2', commands: [] },
    { id: 'D3', commands: ['openspec validate demo --strict'] },
  ]);
  assert.deepEqual(baseline('rules: {}\n', 'demo'), []);
});

const DOD_OK = `## Definition of Done

- [ ] D1 Revue. Vérifié par : \`bash .awf/scripts/tdd-gate.sh review api\`
- [ ] D2 Le README décrit le change. Manuel
- [ ] D3 Specs. Vérifié par : \`openspec validate demo --strict\`
`;

function socle(config: string, tasks: string) {
  const root = project('demo', tasks);
  writeFileSync(join(root, 'openspec', 'config.yaml'), config);
  return root;
}

const CONFIG_EN = `rules:
  tasks:
    - "Definition of Done baseline, copied into every change: D1 the REVIEW passes (\`bash .awf/scripts/tdd-gate.sh review api\` for api/; the mutation covers code only) ; D2 the README describes the change; D3 the specs are synced (\`openspec validate <change> --strict\`)."
`;

test('baseline: the English title "Definition of Done baseline" gives the same criteria', () => {
  assert.deepEqual(baseline(CONFIG_EN, 'demo'), [
    { id: 'D1', commands: ['bash .awf/scripts/tdd-gate.sh review api'] },
    { id: 'D2', commands: [] },
    { id: 'D3', commands: ['openspec validate demo --strict'] },
  ]);
});

test('CLI check-baseline: English baseline and English criteria', () => {
  const tasks = DOD_OK.replaceAll('Vérifié par :', 'Verified by:').replace('. Manuel', '. Manual');

  assert.equal(cli(socle(CONFIG_EN, tasks), 'check-baseline', 'demo').status, 0);
  const missing = cli(socle(CONFIG_EN, tasks.replace(/- \[ \] D3.*\n/, '')), 'check-baseline', 'demo');
  assert.equal(missing.status, 30);
  assert.match(missing.err, /D3/);
});

test('CLI check-baseline: a met baseline passes, a missing criterion or a different command fails (30) naming the criterion', () => {
  assert.equal(cli(socle(CONFIG, DOD_OK), 'check-baseline', 'demo').status, 0);

  const weakened = cli(socle(CONFIG, DOD_OK.replace(' Vérifié par : `bash .awf/scripts/tdd-gate.sh review api`', '')), 'check-baseline', 'demo');
  assert.equal(weakened.status, 30);
  assert.match(weakened.err, /D1/);

  const missing = cli(socle(CONFIG, DOD_OK.replace(/- \[ \] D3.*\n/, '')), 'check-baseline', 'demo');
  assert.equal(missing.status, 30);
  assert.match(missing.err, /D3/);

  const other = cli(socle(CONFIG, DOD_OK.replace('openspec validate demo --strict', 'true')), 'check-baseline', 'demo');
  assert.equal(other.status, 30);
  assert.match(other.err, /D3/);
});

test('undeclaredManual: a criterion without a command or "Manuel" is reported', () => {
  assert.deepEqual(undeclaredManual(criteria(WITH_DOD)).map((c) => c.id), ['D2']);
  assert.deepEqual(undeclaredManual(criteria(DOD_OK)), []);
});

test('undeclaredManual: "Manual" counts like its French alias "Manuel"', () => {
  assert.deepEqual(undeclaredManual(criteria('## Definition of Done\n\n- [ ] D1 Mock-up reviewed. Manual\n- [ ] D2 Mock-up reviewed\n')).map((c) => c.id), ['D2']);
});

test('CLI check-manual: fails naming the criterion (30)', () => {
  const refused = cli(project('demo', '## Definition of Done\n\n- [ ] D6 La maquette est relue\n'), 'check-manual', 'demo');
  assert.equal(refused.status, 30);
  assert.match(refused.err, /D6/);
  assert.equal(cli(project('ok', '## Definition of Done\n\n- [ ] D6 La maquette est relue. Manuel\n'), 'check-manual', 'ok').status, 0);
});

test('CLI --report-only: check-manual and check-baseline list the gaps and return 0', () => {
  const manual = cli(project('demo', '## Definition of Done\n\n- [ ] D6 La maquette est relue\n'), 'check-manual', 'demo', '--report-only');
  assert.equal(manual.status, 0);
  assert.match(manual.out, /D6/);
  const baseline = cli(socle(CONFIG, DOD_OK.replace(/- \[ \] D3.*\n/, '')), 'check-baseline', 'demo', '--report-only');
  assert.equal(baseline.status, 0);
  assert.match(baseline.out, /D3/);
});

test('newlyChecked: the criteria open before and checked after', () => {
  const before = criteria('## Definition of Done\n\n- [ ] D1 a\n- [ ] D2 b\n- [x] D3 c\n');
  const after = criteria('## Definition of Done\n\n- [x] D1 a\n- [ ] D2 b\n- [x] D3 c\n');
  assert.deepEqual(newlyChecked(before, after), ['D1']);
});

test('CLI dod-snapshot then dod-compare: a box checked in between fails (30) naming the criterion', () => {
  const root = project('demo', '## Definition of Done\n\n- [ ] D3 Specs. Vérifié par : `true`\n- [ ] D4 b. Manuel\n');
  const file = join(root, 'openspec', 'changes', 'demo', 'tasks.md');
  assert.equal(cli(root, 'dod-snapshot', 'demo').status, 0);
  assert.equal(cli(root, 'dod-compare', 'demo').status, 0);

  writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] D3 ', '- [x] D3 '));
  const refused = cli(root, 'dod-compare', 'demo');
  assert.equal(refused.status, 30);
  assert.match(refused.err, /D3/);
});

const REPLAY = `## Definition of Done

- [x] D1 Cochée mais en échec. Vérifié par : \`echo rejeu-brut; exit 4\`
- [ ] D2 Ouverte. Vérifié par : \`true\`
`;

test('CLI verify-dod --replay: reruns the command of checked boxes, fails (30) without checking anything', () => {
  const root = project('demo', REPLAY);
  const file = join(root, 'openspec', 'changes', 'demo', 'tasks.md');
  const result = cli(root, 'verify-dod', 'demo', '--replay');

  assert.equal(result.status, 30);
  assert.match(result.err, /D1/);
  assert.match(readFileSync(join(root, '.awf', 'status', 'review-last.txt'), 'utf8'), /rejeu-brut/);
  assert.equal(readFileSync(file, 'utf8'), REPLAY);
});

test('CLI verify-dod --replay: all commands pass, the boxes stay as they are', () => {
  const ok = REPLAY.replace('echo rejeu-brut; exit 4', 'true');
  const root = project('demo', `${ok}\n- [ ] D3 À la main\n`.replace('\n\n- [ ] D3', '\n- [ ] D3'));
  const file = join(root, 'openspec', 'changes', 'demo', 'tasks.md');
  const before = readFileSync(file, 'utf8');
  const result = cli(root, 'verify-dod', 'demo', '--replay');

  assert.equal(result.status, 0);
  assert.match(result.out, /D1/);
  assert.match(result.out, /D2/);
  assert.match(result.out, /to check by hand: D3/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('dodFingerprint: SHA-256 of the section only, sensitive to the command of a criterion', () => {
  const tasks = `${DOD_OK}\n## 1. Socle\n\n- [ ] 1.1 a\n`;
  const fingerprint = dodFingerprint(tasks);

  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(dodFingerprint(tasks.replace('1.1 a', '1.1 b')), fingerprint);
  assert.notEqual(dodFingerprint(tasks.replace('review api', 'review pwa')), fingerprint);
});

test('CLI dod-fingerprint: prints the fingerprint; with a different expected fingerprint, fails (30) citing it', () => {
  const root = project('demo', DOD_OK);
  const fingerprint = cli(root, 'dod-fingerprint', 'demo').out.trim();

  assert.equal(fingerprint, dodFingerprint(DOD_OK));
  assert.equal(cli(root, 'dod-fingerprint', 'demo', fingerprint).status, 0);
  const refused = cli(root, 'dod-fingerprint', 'demo', 'abc123');
  assert.equal(refused.status, 30);
  assert.match(refused.err, /abc123/);
});

const SLICED = `## 2. Tranches

- [ ] 2.1 Calculer le prix dans \`api/\` et l'afficher
  - [x] 2.1.1 [php] calcul du prix
  - [ ] 2.1.2 [ts] affichage du prix
- [ ] 2.2 README : rôles
`;

test('slices: the indented slices of a task, in order, with language and state', () => {
  assert.deepEqual(slices(SLICED, '2.1'), [
    { id: '2.1.1', language: 'php', text: 'calcul du prix', done: true },
    { id: '2.1.2', language: 'ts', text: 'affichage du prix', done: false },
  ]);
});

test('slices: a task that is not code needs no slice', () => {
  assert.deepEqual(slices(SLICED, '2.2'), []);
});

test('slices: a code task without a slice throws, naming the task', () => {
  assert.throws(() => slices('## 2. API\n\n- [ ] 2.1 Calculer le prix dans `api/`\n', '2.1'), (error: unknown) => error instanceof TaskWithoutSlices && error.id === '2.1');
});

test('slices: a slice with two languages throws, a slice without a language too', () => {
  const two = '## 2. API\n\n- [ ] 2.1 Prix dans `api/`\n  - [ ] 2.1.1 [php] [ts] prix\n';
  const none = '## 2. API\n\n- [ ] 2.1 Prix dans `api/`\n  - [ ] 2.1.1 prix\n';

  assert.throws(() => slices(two, '2.1'), (error: unknown) => error instanceof SliceWithTwoLanguages && error.id === '2.1.1');
  assert.throws(() => slices(none, '2.1'), (error: unknown) => error instanceof SliceWithoutLanguage && error.id === '2.1.1');
});

test('slices: a slice of another task is not taken', () => {
  const content = '## 2. API\n\n- [ ] 2.1 Prix dans `api/`\n  - [ ] 2.1.1 [php] a\n- [ ] 2.2 Taxe dans `api/`\n  - [ ] 2.2.1 [php] b\n';

  assert.deepEqual(slices(content, '2.2').map((s) => s.id), ['2.2.1']);
});

test('CLI slices: JSON of the slices; without a slice, failure (1) naming the task', () => {
  const ok = cli(project('demo', SLICED), 'slices', 'demo', '2.1');
  const refused = cli(project('bare', '## 2. API\n\n- [ ] 2.1 Prix dans `api/`\n'), 'slices', 'bare', '2.1');

  assert.equal(ok.status, 0);
  assert.equal((JSON.parse(ok.out) as unknown[]).length, 2);
  assert.equal(refused.status, 1);
  assert.match(refused.err, /2\.1/);
});

test('CLI check-slices: validates every task of the change', () => {
  assert.equal(cli(project('demo', SLICED), 'check-slices', 'demo').status, 0);
  const refused = cli(project('bare', '## 2. API\n\n- [ ] 2.1 Prix dans `api/`\n'), 'check-slices', 'bare');
  assert.equal(refused.status, 1);
  assert.match(refused.err, /2\.1/);
});

test('nextSlice: the first open slice, null when all are checked', () => {
  assert.equal(nextSlice(SLICED, '2.1')?.id, '2.1.2');
  assert.equal(nextSlice(SLICED.replace('[ ] 2.1.2', '[x] 2.1.2'), '2.1'), null);
});

test('checkSlice: checks the slice alone, then the task with the last slice', () => {
  const content = SLICED.replace('[x] 2.1.1', '[ ] 2.1.1');
  const first = checkSlice(content, '2.1.1');

  assert.match(first, /- \[x\] 2\.1\.1 /);
  assert.match(first, /- \[ \] 2\.1 /);
  const last = checkSlice(first, '2.1.2');
  assert.match(last, /- \[x\] 2\.1 /);
  assert.throws(() => checkSlice(last, '2.1.2'), TaskNotOpen);
});

test('CLI check-slice and next-slice: resume after a check', () => {
  const root = project('demo', SLICED);

  assert.equal(JSON.parse(cli(root, 'next-slice', 'demo', '2.1').out).id, '2.1.2');
  assert.equal(cli(root, 'check-slice', 'demo', '2.1.2').status, 0);
  assert.equal(cli(root, 'next-slice', 'demo', '2.1').out.trim(), 'null');
  assert.match(readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[x\] 2\.1 /);
});

test('task-report: lists the slices with their language, the first open one carries the failed phase', () => {
  const root = project('demo', SLICED);
  const dir = join(root, '.awf', 'status');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tdd-slice.json'), '{"phase":"review","code":30}\n');

  const report = JSON.parse(cli(root, 'task-report', 'demo', '2.1', 'failed').out);
  assert.deepEqual(report.slices, [
    { id: '2.1.1', language: 'php', status: 'done', failed: null },
    { id: '2.1.2', language: 'ts', status: 'failed', failed: { phase: 'review', status: 30 } },
  ]);
});

const REGISTRY = readFileSync(join(PROJECT, '.awf', 'languages.yaml'), 'utf8');
/** The four original keys of a language, without the command keys. */
const base = (language: Language | undefined) => language && { workflow: language.workflow, dir: language.dir, tests: language.tests, mutation: language.mutation };

test('registry: php, ts and go have workflow, folder and patterns; api and pwa are aliases', () => {
  const registry = parseLanguages(REGISTRY);

  assert.deepEqual(base(registry.php), { workflow: 'tdd-slice-php', dir: 'api', tests: ['^api/tests/.*Test\\.php$'], mutation: ['^api/(src|tools)/.*\\.php$'] });
  assert.equal(registry.ts?.dir, 'pwa');
  assert.deepEqual(registry.go?.mutation, []);
  assert.deepEqual(registry.api, registry.php);
  assert.deepEqual(registry.pwa, registry.ts);
  for (const name of ['docs', 'stack', 'e2e']) assert.equal(registry[name]?.workflow, 'free-task');
});

test('assertKnownLanguages: an unknown language throws UnknownLanguage with the known languages', () => {
  const registry = parseLanguages(REGISTRY);

  assert.doesNotThrow(() => assertKnownLanguages(slices(SLICED, '2.1'), registry));
  const rust = slices(SLICED.replace('[ts]', '[rust]'), '2.1');
  assert.throws(() => assertKnownLanguages(rust, registry), (error: unknown) => error instanceof UnknownLanguage && error.language === 'rust' && error.id === '2.1.2' && error.known.includes('go'));
});

test('CLI: a [rust] slice exits with code 2 listing the known languages', () => {
  const root = project('demo', SLICED.replace('[ts]', '[rust]'));

  for (const args of [['slices', 'demo', '2.1'], ['next-slice', 'demo', '2.1'], ['check-slices', 'demo']]) {
    const result = cli(root, ...args);
    assert.equal(result.status, 2);
    assert.match(result.err, /rust/);
    assert.match(result.err, /php, ts, threejs, go/);
  }
  assert.equal(JSON.parse(cli(root, 'languages').out).php.dir, 'api');
});

const BARE = '## 2. API\n\n- [ ] 2.1 Prix dans `api/`\n';

test('slices: as a fallback, a task without a slice becomes a single slice classified by the former rule', () => {
  assert.deepEqual(slices(BARE, '2.1', true), [{ id: '2.1', language: 'php', text: 'Prix dans `api/`', done: false }]);
  assert.deepEqual(slices('## 2. PWA\n\n- [ ] 2.1 Le composant `<order-map>`\n', '2.1', true).map((s) => s.language), ['ts']);
  assert.deepEqual(slices(SLICED, '2.1', true).map((s) => s.id), ['2.1.1', '2.1.2']);
  assert.deepEqual(slices(SLICED, '2.2', true), []);
});

test('legacyWarning: names the task, the language and the classification rule', () => {
  assert.match(legacyWarning('2.1', 'api', 'api-marker'), /2\.1.*api.*api-marker/);
});

test('CLI slices: a change already in main applies as a single slice with a warning', () => {
  const root = project('old', BARE);
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-b', 'main');
  git('add', '.');
  git('commit', '-m', 'x');

  const merged = cli(root, 'slices', 'old', '2.1');
  assert.equal(merged.status, 0);
  assert.equal((JSON.parse(merged.out) as { id: string }[])[0]?.id, '2.1');
  assert.match(merged.err, /Warning.*2\.1.*strong:php/);
  assert.equal(cli(project('new', BARE), 'slices', 'new', '2.1').status, 1);
});

test('registry: threejs has its workflow, its pwa folder, the .shape.test.ts tests and no mutation', () => {
  const registry = parseLanguages(REGISTRY);

  assert.deepEqual(base(registry.threejs), { workflow: 'tdd-slice-threejs', dir: 'pwa', tests: ['^pwa/tests/.*\\.shape\\.test\\.ts$'], mutation: [] });
  assert.deepEqual(registry.ts?.tests, ['^pwa/tests/.*\\.test\\.ts$']);
});

const DB_KEYS = ['green_setup', 'green_teardown', 'green_database_url', 'review_setup', 'review_teardown', 'review_database_url'] as const;
const PWA_SCOPE = ['pwa', 'openspec/fixtures', 'contracts', 'docs/mobile/terminaux.json', 'design/direction-artistique/maquette-attractions/annotation', 'README.md', 'bench/references/mobile', 'bench/budgets-modeles.json', '.awf/scripts/model-budget-check.sh', '.awf/scripts/model-budget-count.mts'];

test('registry: php declares its commands, its check tools and the six database keys with their placeholders', () => {
  const { php } = parseLanguages(REGISTRY);

  assert.equal(php?.test, './bin/stack run api-tools composer test');
  assert.equal(php?.review, './bin/stack run api-tools composer review:checks');
  assert.equal(php?.report, 'api/reports/gate-red.xml');
  assert.equal(php?.red, './bin/stack run api-tools vendor/bin/phpunit --log-junit {report} {files}');
  assert.equal(php?.strip, 'api/');
  assert.deepEqual(php?.checks, {
    phpstan: './bin/stack run api-tools vendor/bin/phpstan analyse --no-progress',
    psalm: './bin/stack run api-tools vendor/bin/psalm --no-progress --no-cache',
    phpunit: './bin/stack run api-tools composer test',
    deptrac: './bin/stack run api-tools vendor/bin/deptrac analyse --no-progress',
    infection: '{mutation}',
  });
  assert.equal(php?.last, 'infection');
  assert.deepEqual(php?.review_steps, ['phpstan', 'psalm', 'deptrac', 'phpunit', 'infection']);
  assert.deepEqual(php?.fingerprint_scope, ['api', 'openspec/fixtures', 'contracts', 'docs', 'README.md', 'compose.yaml', 'docker/php', 'docker/web', 'bin']);
  assert.equal(php?.suite_report, 'api/reports/junit-integration.xml');
  assert.match(php?.mutation_cmd ?? '', /bin\/infection-review --threads=\{cpus\} --filter=\{sources\}$/);
  assert.equal(php?.green_setup, 'bash {scripts}/test-database.sh create {change} {slice}');
  assert.equal(php?.green_teardown, 'bash {scripts}/test-database.sh drop {change} {slice}');
  assert.equal(php?.green_database_url, 'bash {scripts}/test-database.sh url {change} {slice}');
  assert.equal(php?.review_setup, 'bash {scripts}/test-database.sh create {change} {label}');
  assert.equal(php?.review_teardown, 'bash {scripts}/test-database.sh drop {change} {label}');
  assert.equal(php?.review_database_url, 'bash {scripts}/test-database.sh url {change} {label}');
});

test('registry: ts, threejs and go leave the six database keys empty; go leaves the fingerprint and the suite report empty', () => {
  const registry = parseLanguages(REGISTRY);

  for (const name of ['ts', 'threejs', 'go']) for (const key of DB_KEYS) assert.equal(registry[name]?.[key], '', `${name}.${key}`);
  for (const name of ['ts', 'threejs']) {
    assert.equal(registry[name]?.test, 'npm --prefix pwa run test:junit');
    assert.deepEqual(registry[name]?.fingerprint_scope, PWA_SCOPE);
    assert.equal(registry[name]?.suite_report, 'pwa/reports/junit.xml');
    assert.equal(registry[name]?.red, 'cd pwa && npx vitest run --reporter=junit --outputFile={report} {files}');
    assert.equal(registry[name]?.strip, 'pwa/');
  }
  assert.deepEqual(registry.go?.fingerprint_scope, []);
  assert.equal(registry.go?.suite_report, '');
  assert.equal(registry.go?.test, 'cd go && go test ./...');
  assert.equal(registry.go?.red, 'echo "Go n\'a pas de rapport JUnit par défaut : définissez TDD_RED_CMD."; exit 1');
  assert.equal(registry.go?.mutation_cmd, '');
  assert.equal(registry.threejs?.mutation_cmd, '');
  assert.match(registry.ts?.mutation_cmd ?? '', /\{mem_wrap\}env --chdir=pwa .* --concurrency \{cpus\} --mutate '\{sources\}'$/);
});

test('registry: review_steps of the four languages, each tool is a checks key and last is one of them', () => {
  const registry = parseLanguages(REGISTRY);

  assert.deepEqual(registry.ts?.review_steps, ['tsc', 'eslint', 'depcruise', 'vitest', 'stryker']);
  assert.deepEqual(registry.threejs?.review_steps, ['tsc', 'eslint', 'depcruise', 'vitest', 'budget', 'capture']);
  assert.deepEqual(registry.go?.review_steps, ['govet', 'gotest']);
  for (const name of ['php', 'ts', 'threejs', 'go']) {
    const language = registry[name];
    assert.deepEqual([...(language?.review_steps ?? [])].sort(), Object.keys(language?.checks ?? {}).sort(), name);
    assert.ok(language?.review_steps.includes(language.last), name);
  }
  assert.equal(registry.ts?.last, 'stryker');
  assert.equal(registry.threejs?.last, 'capture');
  assert.equal(registry.go?.last, 'gotest');
});

test('registry: proofs names checks tools, without capture, under a fingerprint scope; go and the free languages have none', () => {
  const registry = parseLanguages(REGISTRY);

  assert.deepEqual(registry.php?.proofs, ['phpstan', 'psalm', 'deptrac', 'phpunit', 'infection']);
  assert.deepEqual(registry.ts?.proofs, ['tsc', 'eslint', 'depcruise', 'vitest', 'stryker']);
  assert.deepEqual(registry.threejs?.proofs, ['tsc', 'eslint', 'depcruise', 'vitest', 'budget']);
  assert.deepEqual(registry.go?.proofs, []);
  assert.deepEqual(registry.docs?.proofs, []);
  for (const name of ['php', 'ts', 'threejs']) {
    const language = registry[name];
    for (const tool of language?.proofs ?? []) assert.ok(tool in (language?.checks ?? {}), `${name}.${tool}`);
    assert.notEqual(language?.fingerprint_scope.length, 0, name);
  }
});

test('registry: threejs declares budget, capture and models; the other languages leave them empty', () => {
  const registry = parseLanguages(REGISTRY);

  assert.equal(registry.threejs?.budget, 'bash {scripts}/model-budget-check.sh {models}');
  assert.match(registry.threejs?.capture ?? '', /^flock -w 600 -E 12 \S*model-capture\.lock \{mem_wrap\}node --experimental-transform-types \{root\}\/\.awf\/scripts\/capture-modele\.mts \{models\}$/);
  assert.deepEqual(registry.threejs?.models, ['^pwa/src/.*/infrastructure/[^/]*-model\\.ts$']);
  assert.deepEqual(registry.threejs?.checks.budget, '{budget}');
  assert.deepEqual(registry.threejs?.checks.capture, '{capture}');
  for (const name of ['php', 'ts', 'go']) {
    assert.equal(registry[name]?.budget, '', name);
    assert.equal(registry[name]?.capture, '', name);
    assert.deepEqual(registry[name]?.models, [], name);
  }
});

test('registry: a missing key is an empty string, list or table', () => {
  const { docs } = parseLanguages(REGISTRY);

  assert.equal(docs?.test, '');
  assert.equal(docs?.review_setup, '');
  assert.deepEqual(docs?.review_steps, []);
  assert.deepEqual(docs?.checks, {});
});

test('parseLanguages: inline list, table, doubled quote and underscored key', () => {
  const { x } = parseLanguages('x:\n  workflow: w\n  review_steps: [a, \'b\']\n  checks:\n    a: \'{mutation}\'\n    b-c: echo \'\'d\'\' && true\n  red: \'dit : \'\'non\'\'\'\n  tests:\n    - t\n');

  assert.deepEqual(x?.review_steps, ['a', 'b']);
  assert.deepEqual(x?.checks, { a: '{mutation}', 'b-c': 'echo \'\'d\'\' && true' });
  assert.equal(x?.red, 'dit : \'non\'');
  assert.deepEqual(x?.tests, ['t']);
});

test('CLI languages: exposes the command keys, aliases resolved', () => {
  const registry = JSON.parse(cli(project('registre', SLICED), 'languages').out) as Record<string, Language>;

  assert.equal(registry.api?.green_setup, 'bash {scripts}/test-database.sh create {change} {slice}');
  assert.deepEqual(registry.api, registry.php);
  assert.deepEqual(registry.pwa, registry.ts);
  assert.deepEqual(registry.pwa?.review_steps, ['tsc', 'eslint', 'depcruise', 'vitest', 'stryker']);
  assert.equal(registry.threejs?.checks.capture, '{capture}');
  assert.deepEqual(registry.go?.fingerprint_scope, []);
  assert.deepEqual(registry.api?.proofs, ['phpstan', 'psalm', 'deptrac', 'phpunit', 'infection']);
  assert.deepEqual(registry.pwa?.proofs, registry.ts?.proofs);
  assert.deepEqual(registry.threejs?.proofs, ['tsc', 'eslint', 'depcruise', 'vitest', 'budget']);
  assert.deepEqual(registry.go?.proofs, []);
});

test('slices: a [threejs] slice is accepted, a [ts] [threejs] slice fails (code 1 of SliceWithTwoLanguages)', () => {
  const ok = '## 2. PWA\n\n- [ ] 2.1 Modèle dans `pwa/`\n  - [ ] 2.1.1 [threejs] forme\n';
  const two = '## 2. PWA\n\n- [ ] 2.1 Modèle dans `pwa/`\n  - [ ] 2.1.1 [ts] [threejs] forme\n';

  assert.doesNotThrow(() => assertKnownLanguages(slices(ok, '2.1'), parseLanguages(REGISTRY)));
  assert.throws(() => slices(two, '2.1'), (error: unknown) => error instanceof SliceWithTwoLanguages && error.id === '2.1.1');

  const root = project('demo', two);
  const result = cli(root, 'slices', 'demo', '2.1');
  assert.equal(result.status, 1);
  assert.match(result.err, /2\.1\.1/);
});

test('apply-task: the registry workflow for threejs is routed to run_threejs, which calls tdd-slice-threejs', () => {
  const yaml = readFileSync(join(SCRIPTS, '..', 'workflows', 'apply-task.yaml'), 'utf8');

  assert.match(yaml, /states\.slice_workflow\.Output == "tdd-slice-threejs"'\n\s+goto: run_threejs/);
  assert.match(yaml, /\n  run_threejs:\n    type: call_workflow\n    timeout: 28800\n    workflow: tdd-slice-threejs\n/);
  assert.match(yaml, /- run_threejs\n/);
});

const VERIFY = [
  '## 1. Essai',
  '',
  '- [ ] 1.1 [stack] Réussit. Vérifié par : `echo ok-sortie`',
  '- [ ] 1.2 [stack] Échoue. Vérifié par : `echo sortie-ratee >&2; exit 3`',
  '- [ ] 1.3 [stack] Contrôle humain. Vérifié par : Manuel',
  '- [ ] 1.4 [stack] Sans mention',
  '',
].join('\n');

test('verify-task: a command that succeeds exits with 0 and does not check the box', () => {
  const root = project('demo', VERIFY);
  const result = cli(root, 'verify-task', 'demo', '1.1');

  assert.equal(result.status, 0);
  assert.match(readFileSync(join(root, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8'), /- \[ \] 1\.1 /);
});

test('verify-task: a task already checked (by the agent of the task) is verified as an open task', () => {
  const ticked = VERIFY.replace('- [ ] 1.1 ', '- [x] 1.1 ').replace('- [ ] 1.2 ', '- [x] 1.2 ');
  const root = project('demo', ticked);

  assert.equal(cli(root, 'verify-task', 'demo', '1.1').status, 0);
  assert.equal(cli(root, 'verify-task', 'demo', '1.2').status, 30);
});

test('verify-task: a command that fails exits with 30 and prints its output', () => {
  const result = cli(project('demo', VERIFY), 'verify-task', 'demo', '1.2');

  assert.equal(result.status, 30);
  assert.match(result.err, /sortie-ratee/);
});

test('verify-task: "Manuel" and a line without mention exit with 31', () => {
  const root = project('demo', VERIFY);

  assert.equal(cli(root, 'verify-task', 'demo', '1.3').status, 31);
  assert.equal(cli(root, 'verify-task', 'demo', '1.4').status, 31);
});

test('verify-task: get verify returns the command, empty without mention', () => {
  const root = project('demo', VERIFY);

  assert.equal(cli(root, 'get', 'demo', '1.1', 'verify').out, 'echo ok-sortie');
  assert.equal(cli(root, 'get', 'demo', '1.3', 'verify').out, '');
  assert.equal(cli(root, 'get', 'demo', '1.4', 'verify').out, '');
});

const VERIFY_EN = [
  '## 1. Trial',
  '',
  '- [ ] 1.1 [stack] Succeeds. Verified by: `echo ok-output`',
  '- [ ] 1.2 [stack] Fails. Verified by: `exit 3`',
  '- [ ] 1.3 [stack] Human check. Verified by: Manual',
  '',
].join('\n');

test('verify-task: "Verified by:" works like its French alias, "Verified by: Manual" exits with 31', () => {
  const root = project('demo', VERIFY_EN);

  assert.equal(cli(root, 'verify-task', 'demo', '1.1').status, 0);
  assert.equal(cli(root, 'verify-task', 'demo', '1.2').status, 30);
  assert.equal(cli(root, 'verify-task', 'demo', '1.3').status, 31);
  assert.equal(cli(root, 'get', 'demo', '1.1', 'verify').out, 'echo ok-output');
  assert.equal(cli(root, 'get', 'demo', '1.3', 'verify').out, '');
});

test('commitMessage: the "Verified by:" mention is removed from the subject, like "Vérifié par :"', () => {
  assert.equal(commitMessage('demo', { text: '[tooling] Code. Verified by: `true`', hexagon: 'stack' }), 'feat(demo): Code.');
  assert.equal(commitMessage('demo', { text: '[outillage] Code. Vérifié par : `true`', hexagon: 'stack' }), 'feat(demo): Code.');
});

const COMMIT = [
  '## 1. Essai',
  '',
  '- [x] 1.1 [outillage] Code. Vérifié par : `true`',
  '- [x] 1.2 [docs] README : section du flux, avec une description volontairement très longue pour dépasser. Vérifié par : `true`',
  '',
].join('\n');

function repo(ignoreStatus = true, content = COMMIT): string {
  const root = project('demo', content);
  // As in the project repository, .awf/status/ is ignored by Git: `git add` fails on an ignored path cited explicitly.
  if (ignoreStatus) writeFileSync(join(root, '.gitignore'), '.awf/status/\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) spawnSync('git', args, { cwd: root, env });
  return root;
}
const git = (root: string, ...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout;

test('commit-task: commits the tree except .awf/status/ with a feat message without a tool trace', () => {
  const root = repo();
  writeFileSync(join(root, 'a.txt'), 'a');
  mkdirSync(join(root, '.awf', 'status'), { recursive: true });
  writeFileSync(join(root, '.awf', 'status', 'x.json'), '{}');
  const result = cli(root, 'commit-task', 'demo', '1.1');

  assert.equal(result.status, 0);
  assert.equal(git(root, 'log', '-1', '--format=%B').trim(), 'feat(demo): Code.');
  assert.match(git(root, 'show', '--stat', '--format=', 'HEAD'), /a\.txt/);
  assert.doesNotMatch(git(root, 'show', '--stat', '--format=', 'HEAD'), /status/);
  assert.doesNotMatch(git(root, 'log', '-1', '--format=%B'), /Co-Authored-By|Claude/i);
});

test('commit-task: .awf/status/ not ignored by Git stays out of the commit', () => {
  const root = repo(false);
  writeFileSync(join(root, 'a.txt'), 'a');
  mkdirSync(join(root, '.awf', 'status'), { recursive: true });
  writeFileSync(join(root, '.awf', 'status', 'x.json'), '{}');
  const result = cli(root, 'commit-task', 'demo', '1.1');

  assert.equal(result.status, 0);
  assert.match(git(root, 'show', '--stat', '--format=', 'HEAD'), /a\.txt/);
  assert.doesNotMatch(git(root, 'show', '--stat', '--format=', 'HEAD'), /status/);
});

test('commit-task: a docs task gives docs(...) and a subject of 72 characters at most', () => {
  const root = repo();
  writeFileSync(join(root, 'b.txt'), 'b');
  cli(root, 'commit-task', 'demo', '1.2');
  const subject = git(root, 'log', '-1', '--format=%s').trim();

  assert.match(subject, /^docs\(demo\): README/);
  assert.ok(subject.length <= 72);
});

test('commit-task: no change, no commit, code 0', () => {
  const root = repo();
  const before = git(root, 'rev-list', '--count', 'HEAD');
  const result = cli(root, 'commit-task', 'demo', '1.1');

  assert.equal(result.status, 0);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), before);
});

test('commit-task: a failing pre-commit hook prevents the commit (no --no-verify)', () => {
  const root = repo();
  writeFileSync(join(root, 'c.txt'), 'c');
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const before = git(root, 'rev-list', '--count', 'HEAD');
  const result = cli(root, 'commit-task', 'demo', '1.1');

  assert.notEqual(result.status, 0);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), before);
});

const COMMIT_SLICES = [
  '## 2. Tranches',
  '',
  '- [ ] 2.1 Agrégat `Order`. Vérifié par : `true`',
  '  - [x] 2.1.1 [php] Ouvrir le parc',
  '  - [ ] 2.1.2 [php] Fermer le parc, avec une description volontairement très longue pour dépasser la limite du sujet',
  '- [ ] 2.2 Guide',
  '  - [ ] 2.2.1 [docs] Décrire le flux',
  '',
].join('\n');

test('commit-slice: commits the tree except .awf/status/ with a feat message from the slice, without a tool trace', () => {
  const root = repo(true, COMMIT_SLICES);
  writeFileSync(join(root, 'a.txt'), 'a');
  mkdirSync(join(root, '.awf', 'status'), { recursive: true });
  writeFileSync(join(root, '.awf', 'status', 'x.json'), '{}');
  const result = cli(root, 'commit-slice', 'demo', '2.1.1');

  assert.equal(result.status, 0);
  assert.equal(git(root, 'log', '-1', '--format=%B').trim(), 'feat(demo): Ouvrir le parc');
  assert.match(git(root, 'show', '--stat', '--format=', 'HEAD'), /a\.txt/);
  assert.doesNotMatch(git(root, 'show', '--stat', '--format=', 'HEAD'), /status/);
  assert.doesNotMatch(git(root, 'log', '-1', '--format=%B'), /Co-Authored-By|Claude/i);
});

test('commit-slice: a [docs] slice gives docs(...)', () => {
  const root = repo(true, COMMIT_SLICES);
  writeFileSync(join(root, 'b.txt'), 'b');
  cli(root, 'commit-slice', 'demo', '2.2.1');

  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), 'docs(demo): Décrire le flux');
});

test('commit-slice: a subject of 72 characters at most, cut with an ellipsis', () => {
  const root = repo(true, COMMIT_SLICES);
  writeFileSync(join(root, 'c.txt'), 'c');
  cli(root, 'commit-slice', 'demo', '2.1.2');
  const subject = git(root, 'log', '-1', '--format=%s').trim();

  assert.match(subject, /^feat\(demo\): Fermer le parc.*\.\.\.$/);
  // The cut falls on a space, removed before the ellipsis: 71 characters.
  assert.equal(subject, 'feat(demo): Fermer le parc, avec une description volontairement très...');
  assert.ok(subject.length <= 72);
});

test('commit-slice: no change, no commit, code 0', () => {
  const root = repo(true, COMMIT_SLICES);
  const before = git(root, 'rev-list', '--count', 'HEAD');
  const result = cli(root, 'commit-slice', 'demo', '2.1.1');

  assert.equal(result.status, 0);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), before);
});

test('commit-slice: an unknown slice throws UnknownSlice, without a commit', () => {
  const root = repo(true, COMMIT_SLICES);
  writeFileSync(join(root, 'd.txt'), 'd');
  const before = git(root, 'rev-list', '--count', 'HEAD');

  for (const id of ['2.1.9', '9.1.1', '2.1', '2']) {
    const result = cli(root, 'commit-slice', 'demo', id);
    assert.equal(result.status, 1, id);
    assert.match(result.err, new RegExp(`No slice has this number.* Change: demo, slice: ${id.replaceAll('.', '\\.')}\\.`), id);
  }
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), before);

  process.env.OPENSPEC_ROOT = root;
  try {
    assert.throws(() => commitSlice('demo', '2.1.9'), UnknownSlice);
  } finally {
    process.env.OPENSPEC_ROOT = PROJECT;
  }
});

test('commit-slice: the commit of the last slice contains the box of the task', () => {
  const root = repo(true, COMMIT_SLICES);
  writeFileSync(join(root, 'e.txt'), 'e');
  assert.equal(cli(root, 'check-slice', 'demo', '2.1.2').status, 0);
  const result = cli(root, 'commit-slice', 'demo', '2.1.2');
  const diff = git(root, 'show', '--format=', 'HEAD');

  assert.equal(result.status, 0);
  assert.match(diff, /^\+- \[x\] 2\.1 /m);
  assert.match(diff, /^\+ {2}- \[x\] 2\.1\.2 /m);
  assert.match(diff, /e\.txt/);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

test('a [stack] task is manual, stack hexagon', () => {
  assert.deepEqual(classify('[stack] Image de l\'API avec les extensions PHP', '1. Stack'), { kind: 'manual', hexagon: 'stack', rule: 'stack-tag' });
});

test('openTasks: a task that declares slices is a task with slices, whatever its text', () => {
  const content = [
    '## 4. Section management : indicateurs',
    '',
    '- [x] 4.0 Sans indice',
    '  - [ ] 4.0.1 [php] tranche d\'une tâche cochée',
    '- [ ] 4.1 Sans indice',
    '  - [ ] 4.1.1 [ts] RED, GREEN, REVIEW : badge',
    '- [ ] 4.2 Sans indice, côté serveur',
    '  - [ ] 4.2.1 [php] RED, GREEN, REVIEW : dépôt',
    '- [ ] 4.3 Sans indice ni tranche',
  ].join('\n');

  assert.deepEqual(openTasks(content).map((t) => [t.id, t.kind, t.hexagon, t.rule]), [
    ['4.1', 'slice', 'ts', 'slices'],
    ['4.2', 'slice', 'php', 'slices'],
    ['4.3', 'manual', 'docs', 'default'],
  ]);
});

test('classify: [outillage] at the end of the line counts as the leading tag', () => {
  assert.deepEqual(classify('Déplacer les tests des composants (vérifié par D9) [outillage]', '2. Section play'), { kind: 'manual', hexagon: 'stack', rule: 'outillage' });
});

// --- Rust entries and critical slices ---

test('alias: an entry takes every field of its target and overrides the ones it declares', () => {
  const registry = parseLanguages(`rust:
  workflow: tdd-slice-rust
  red: cargo test --lib -- functional::
  tests:
    - '^tests/.*\\.rs$'
  checks:
    fmt: cargo fmt --check
  review_steps: [fmt]
rust-unit:
  alias: rust
  red: cargo test --lib
rust-perf:
  alias: rust
  workflow: tdd-slice-rust-perf
  perf: cat {bench}
  perf_benches: [fib, strings]
  perf_tolerance: 2
  critical_steps: [harness, trace]
  required: [harness]
  harness_paths: [fuzz]
`);

  assert.equal(registry['rust-unit']?.workflow, 'tdd-slice-rust');
  assert.equal(registry['rust-unit']?.red, 'cargo test --lib');
  assert.deepEqual(registry['rust-unit']?.tests, ['^tests/.*\\.rs$']);
  assert.deepEqual(registry['rust-unit']?.checks, { fmt: 'cargo fmt --check' });
  assert.equal(registry['rust-perf']?.workflow, 'tdd-slice-rust-perf');
  assert.equal(registry['rust-perf']?.perf, 'cat {bench}');
  assert.deepEqual(registry['rust-perf']?.perf_benches, ['fib', 'strings']);
  assert.equal(registry['rust-perf']?.perf_tolerance, '2');
  assert.deepEqual(registry['rust-perf']?.critical_steps, ['harness', 'trace']);
  assert.deepEqual(registry['rust-perf']?.required, ['harness']);
  assert.deepEqual(registry['rust-perf']?.harness_paths, ['fuzz']);
  assert.deepEqual(registry.rust?.perf_benches, []);
});

test('slices: [critical] next to the language tag, in either order, marks the slice critical', () => {
  const content = '## 2. Store\n\n- [ ] 2.1 Store\n  - [ ] 2.1.1 [rust] [critical] keeps data\n  - [ ] 2.1.2 [critical] [php] other\n  - [ ] 2.1.3 [go] plain\n';

  assert.deepEqual(slices(content, '2.1').map((s) => [s.id, s.language, s.critical === true, s.text]), [
    ['2.1.1', 'rust', true, 'keeps data'],
    ['2.1.2', 'php', true, 'other'],
    ['2.1.3', 'go', false, 'plain'],
  ]);
  assert.equal('critical' in (slices(content, '2.1')[2] ?? {}), false);
});

test('slices: [critical] alone has no language, [critical] does not lift the one-language rule', () => {
  assert.throws(() => slices('- [ ] 2.1 T\n  - [ ] 2.1.1 [critical] x\n', '2.1'), (error: unknown) => error instanceof SliceWithoutLanguage && error.id === '2.1.1');
  assert.throws(() => slices('- [ ] 2.1 T\n  - [ ] 2.1.1 [rust] [critical] [go] x\n', '2.1'), (error: unknown) => error instanceof SliceWithTwoLanguages);
});

test('CLI slices: the JSON of a critical slice carries critical: true', () => {
  const root = project('demo', '## 2. Store\n\n- [ ] 2.1 Store\n  - [ ] 2.1.1 [php] [critical] keeps data\n');
  const result = cli(root, 'slices', 'demo', '2.1');

  assert.equal(result.status, 0, result.err);
  assert.deepEqual((JSON.parse(result.out) as { critical?: boolean }[])[0]?.critical, true);
});

// --- Keywords of the registry ---

test('openTasks: a slice of any code language makes its task a code task, a slice of a free kind does not', () => {
  const content = [
    '## 1. Misc',
    '',
    '- [ ] 1.1 Speed up the parser',
    '  - [ ] 1.1.1 [go] Parse lines faster',
    '- [ ] 1.2 Unknown language',
    '  - [ ] 1.2.1 [cobol] Batch job',
    '- [ ] 1.3 README: walkthrough',
    '  - [ ] 1.3.1 [docs] Walkthrough page',
    '- [ ] 1.4 Through an alias',
    '  - [ ] 1.4.1 [api] Thing',
  ].join('\n');

  assert.deepEqual(openTasks(content).map((t) => [t.id, t.kind, t.hexagon]), [
    ['1.1', 'slice', 'go'],
    ['1.2', 'slice', 'cobol'],
    ['1.3', 'manual', 'docs'],
    ['1.4', 'slice', 'php'],
  ]);
});

test('classify: without a registry, only the built-in markers apply', () => {
  assert.deepEqual(classify('Repository and adapters of the orders', '1. Domain layer', []), { kind: 'manual', hexagon: 'docs', rule: 'default' });
  assert.deepEqual(classify('[stack] Base image', '1. X', []), { kind: 'manual', hexagon: 'stack', rule: 'stack-tag' });
  assert.deepEqual(classify('REVIEW of `api/`', '1. X', []), { kind: 'review', hexagon: '', rule: 'review' });
});

test('keywordEntries: aliases have no keywords of their own and the canonical key is returned', () => {
  const content = "php:\n  workflow: tdd-slice-php\n  keywords:\n    - 'repository'\napi:\n  alias: php\nts:\n  workflow: tdd-slice-ts\n  keywords:\n    - 'component'\n";
  const entries = keywordEntries(parseLanguages(content), aliasTargets(content));

  assert.deepEqual(entries.map((e) => e.key), ['php', 'ts']);
  assert.deepEqual(classify('The order repository', '1. X', entries), { kind: 'slice', hexagon: 'php', rule: 'keywords:php' });
});

test('keywordEntries: a keyword that is not a valid regular expression throws InvalidKeyword with its cause', () => {
  const content = "php:\n  workflow: tdd-slice-php\n  group_keywords:\n    - '(unclosed'\n";

  assert.throws(() => keywordEntries(parseLanguages(content), aliasTargets(content)), (error: unknown) =>
    error instanceof InvalidKeyword && error.language === 'php' && error.field === 'group_keywords' && error.pattern === '(unclosed'
    && error.cause instanceof SyntaxError && !error.message.includes('unclosed'));
});
