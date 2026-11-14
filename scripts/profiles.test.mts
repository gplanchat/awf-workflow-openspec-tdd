// Agent profiles of the workflows: every agent step cites a profile skill that exists in skills/, and the Three.js
// skill and prompts cite what a model slice needs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, 'workflows');
const SKILLS = join(ROOT, 'skills');

type Step = { step: string; skills: string[]; allowedTools: string; promptFile: string };

/** The `type: agent` steps of a workflow, with their `skills:` (inline list or dashes). */
function agentSteps(text: string): Step[] {
  return text
    .split(/^(?=  [A-Za-z_][\w-]*:\s*$)/m)
    .filter((block) => /^ {4}type:\s*agent\s*$/m.test(block))
    .map((block) => {
      const inline = block.match(/^ {4}skills:\s*\[(.*)\]\s*$/m)?.[1];
      const dashed = block.match(/^ {4}skills:\s*\n((?: {6}- .*\n?)+)/m)?.[1];
      const raw = inline?.split(',') ?? dashed?.split('\n').map((line) => line.replace(/^\s*-\s*/, '')) ?? [];
      return {
        step: block.match(/^ {2}([\w-]+):/)?.[1] ?? '?',
        skills: raw.map((name) => name.trim().replace(/^["']|["']$/g, '')).filter((name) => name !== ''),
        allowedTools: block.match(/^ {6}allowed_tools:\s*"?([^"\n]*?)"?\s*$/m)?.[1] ?? '',
        promptFile: block.match(/^ {4}prompt_file:\s*"?([^"\n]*?)"?\s*$/m)?.[1] ?? '',
      };
    });
}

function content(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function packSteps(): { file: string; step: Step }[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yaml'))
    .flatMap((file) => agentSteps(readFileSync(join(WORKFLOWS, file), 'utf8')).map((step) => ({ file, step })));
}

test('every agent step declares a profile skill', () => {
  const steps = packSteps();
  const withoutSkill = steps.filter(({ step }) => step.skills.length === 0).map(({ file, step }) => `${file}, step ${step.step}`);

  assert.ok(steps.length >= 5, 'the test must see the five agent steps of tdd-slice and free-task');
  assert.deepEqual(withoutSkill, [], 'Add "skills: [<name>]" to these steps: the name is a directory of skills/.');
});

test('no step uses role: or system_prompt:, which awf 0.11.0 ignores', () => {
  const ignored = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yaml'))
    .filter((name) => /^ +(role|system_prompt):/m.test(readFileSync(join(WORKFLOWS, name), 'utf8')));

  assert.deepEqual(ignored, [], 'Put the profile in a skill of skills/ and cite it in skills:.');
});

test('every cited skill exists under skills/ (bare name or path: relative to the workflow) and is not empty', () => {
  const missing = packSteps()
    .flatMap(({ file, step }) => step.skills.map((name) => ({ file, step: step.step, name })))
    .filter(({ name }) => content(name.startsWith('path:') ? join(WORKFLOWS, name.slice(5).trim(), 'SKILL.md') : join(SKILLS, name, 'SKILL.md')) === '')
    .map(({ file, step, name }) => `${file}, step ${step}: skill ${name}`);

  assert.deepEqual(missing, [], 'Place the skill in skills/<name>/SKILL.md.');
});

// awf looks up a bare skill name in the project and user directories, never in the pack: `awf validate` then fails.
test('every skill is cited by a path relative to the workflow, so that awf finds it in the pack', () => {
  const bare = packSteps()
    .flatMap(({ file, step }) => step.skills.map((name) => ({ file, step: step.step, name })))
    .filter(({ name }) => !name.startsWith('path:'))
    .map(({ file, step, name }) => `${file}, step ${step}: ${name}`);

  assert.deepEqual(bare, [], 'Cite the skill as "- path: ../skills/<name>".');
});

test('every prompt_file of an agent step exists under prompts/', () => {
  const missing = packSteps()
    .filter(({ step }) => step.promptFile !== '')
    .filter(({ step }) => content(join(ROOT, 'prompts', step.promptFile.replace('{{.awf.prompts_dir}}/', ''))) === '')
    .map(({ file, step }) => `${file}, step ${step.step}: ${step.promptFile}`);

  assert.deepEqual(missing, [], 'Place the prompt in prompts/ or fix prompt_file.');
});

test('the step reader finds inline and dashed skills', () => {
  const example = [
    'states:',
    '  initial: a',
    '  a:',
    '    type: agent',
    '    skills: [x, "y"]',
    '    prompt_file: "{{.awf.prompts_dir}}/x.md"',
    '    options:',
    '      allowed_tools: "Read,Bash(ls:*)"',
    '  b:',
    '    type: agent',
    '    skills:',
    '      - z',
    '  c:',
    '    type: step',
    '',
  ].join('\n');

  assert.deepEqual(agentSteps(example), [
    { step: 'a', skills: ['x', 'y'], allowedTools: 'Read,Bash(ls:*)', promptFile: '{{.awf.prompts_dir}}/x.md' },
    { step: 'b', skills: ['z'], allowedTools: '', promptFile: '' },
  ]);
});

const THREEJS_PROMPTS = ['tdd-threejs-red.md', 'tdd-threejs-green.md', 'tdd-threejs-back-to-green.md'];

test('the tdd-threejs skill and the three Three.js prompts cite the Three.js skills, the model budget file and the shape suffix', () => {
  const files = [join(SKILLS, 'tdd-threejs', 'SKILL.md'), ...THREEJS_PROMPTS.map((name) => join(ROOT, 'prompts', name))];
  const gaps = files.flatMap((file) => {
    const text = content(file);
    return ['threejs-geometry', 'threejs-materials', 'model budget file', '`budget` check', '.shape.test.ts']
      .filter((key) => !text.includes(key))
      .map((key) => `${file.slice(ROOT.length + 1)}: ${key}`);
  });

  assert.deepEqual(gaps, [], 'Each file must cite both Three.js skills, the model budget file that the `budget` check reads, and the .shape.test.ts suffix.');
});

test('tdd-slice-threejs.yaml names the three Three.js prompts', () => {
  const workflow = readFileSync(join(WORKFLOWS, 'tdd-slice-threejs.yaml'), 'utf8');

  for (const name of THREEJS_PROMPTS) assert.ok(workflow.includes(name), `tdd-slice-threejs.yaml must name ${name}.`);
});

// The names of the projects the pack comes from, each built from two parts so that this file does not match itself.
const ORIGIN = new RegExp([['hex', 'fair'], ['pa', 'rk']].map((parts) => parts.join('')).join('|'), 'i');

test('no text of the pack names the project it was extracted from', () => {
  const dirs = ['workflows', 'prompts', 'skills', 'scripts', 'hooks', 'examples'];
  const files = dirs.flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name)))
    .concat(['manifest.yaml', 'README.md', 'CONTRIBUTING.md', 'NOTICE'].map((name) => join(ROOT, name)));
  const named = files.filter((file) => ORIGIN.test(readFileSync(file, 'utf8'))).map((file) => file.slice(ROOT.length + 1));

  assert.deepEqual(named, [], 'Remove the name of the origin project from these files.');
});
